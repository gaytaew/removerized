import { useCallback, useRef, useState } from "react"

import { MODELS } from "../constants"
import { checkAndDownloadModel } from "../lib/idb"
import {
  applyColorizerChromaToOriginal,
  applyMaskAsAlpha,
  preprocessImage,
  preprocessImageToImage,
  tensorToImageData,
} from "../lib/onnx-pipeline"
import type { ModelKey, ModelStatus, ProgressCallback } from "../types"

type Ort = typeof import("onnxruntime-web")
type InferenceSession = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>
const SESSION_CREATE_TIMEOUT_MS = 90 * 1000
const INFERENCE_TIMEOUT_MS = 120 * 1000
const RUNTIME_INIT_TIMEOUT_MS = 15 * 1000

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(timeoutMessage)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

/** Hook return contract */
export interface UseOnnxSessionReturn {
  modelStatus: ModelStatus
  downloadProgress: number
  runInference: (
    imgEl: HTMLImageElement,
    modelKey: ModelKey,
    onUpdate: ProgressCallback,
    quality?: number
  ) => Promise<Blob>
  runImageToImage: (
    imgEl: HTMLImageElement,
    modelKey: ModelKey,
    onUpdate: ProgressCallback,
    options?: { size?: number; quality?: number }
  ) => Promise<Blob>
  setModelStatus: (status: ModelStatus) => void
}

/**
 * Manages ONNX Runtime sessions on the client.
 *
 * - Avoids SSR issues by using a lazy-loaded ortRef
 * - Caches sessions per model
 * - Handles download + inference pipeline
 */
export const useOnnxSession = (
  ortRef: React.RefObject<Ort | null>,
  ortReadyRef: React.RefObject<Promise<Ort> | null>
): UseOnnxSessionReturn => {
  /** In-memory session cache per model */
  const sessionCache = useRef<Partial<Record<ModelKey, InferenceSession>>>({})

  const [modelStatus, setModelStatus] = useState<ModelStatus>("idle")
  const [downloadProgress, setDownloadProgress] = useState(0)

  const getRuntime = useCallback(async (): Promise<Ort> => {
    if (ortRef.current) return ortRef.current

    const pendingRuntime = ortReadyRef.current
    if (!pendingRuntime) {
      throw new Error("ONNX Runtime initialization has not started.")
    }

    const runtime = await withTimeout(
      pendingRuntime,
      RUNTIME_INIT_TIMEOUT_MS,
      "ONNX Runtime initialization timed out."
    )
    ortRef.current = runtime
    return runtime
  }, [ortReadyRef, ortRef])

  /**
   * Get cached session or create a new one.
   */
  const getOrCreateSession = useCallback(
    async (
      modelKey: ModelKey,
      onUpdate: ProgressCallback
    ): Promise<InferenceSession> => {
      const ort = await getRuntime()

      // Fast path: cached session
      if (sessionCache.current[modelKey]) {
        return sessionCache.current[modelKey]!
      }

      setModelStatus("downloading")
      onUpdate("Checking model cache…", 0)

      const handleProgress = (pct: number) => {
        setDownloadProgress(pct)
        onUpdate(
          pct < 100
            ? `Downloading ${MODELS[modelKey].label}… ${pct}%`
            : "Finalizing download…",
          pct
        )
      }

      const model = await checkAndDownloadModel(modelKey, handleProgress)

      onUpdate("Loading session…", 100)

      const createSession = (buffer: ArrayBuffer) =>
        withTimeout(
          ort.InferenceSession.create(buffer, {
            executionProviders: ["wasm"],
            graphOptimizationLevel: "all",
          }),
          SESSION_CREATE_TIMEOUT_MS,
          "Session initialization timed out."
        )

      let session: InferenceSession
      try {
        session = await createSession(model.buffer)
      } catch (error) {
        if (
          model.source !== "cache" ||
          (error instanceof Error &&
            error.message === "Session initialization timed out.")
        ) {
          throw error
        }

        // Cached model data can become incomplete after an interrupted browser
        // write or storage eviction. Refresh it once before surfacing an error.
        onUpdate("Refreshing model cache…", 0)
        const refreshedModel = await checkAndDownloadModel(
          modelKey,
          handleProgress,
          { forceRefresh: true }
        )
        onUpdate("Loading refreshed session…", 100)
        session = await createSession(refreshedModel.buffer)
      }

      sessionCache.current[modelKey] = session
      setModelStatus("ready")

      return session
    },
    [getRuntime]
  )

  /**
   * Run full inference pipeline for an image.
   */
  const runInference = useCallback(
    async (
      imgEl: HTMLImageElement,
      modelKey: ModelKey,
      onUpdate: ProgressCallback,
      quality: number = 0.9
    ): Promise<Blob> => {
      const ort = await getRuntime()
      const session = await getOrCreateSession(modelKey, onUpdate)

      onUpdate("Pre-processing…", 0)
      const inputTensor = preprocessImage(imgEl, ort)

      onUpdate("Running inference…", 0)
      const inputType = MODELS[modelKey].inputType
      const results = await withTimeout(
        session.run({ [inputType]: inputTensor }),
        INFERENCE_TIMEOUT_MS,
        "Inference timed out."
      )

      onUpdate("Post-processing…", 0)
      const maskTensor = results[session.outputNames[0]]
      const blob = await applyMaskAsAlpha(maskTensor, imgEl, quality)

      return blob
    },
    [getOrCreateSession, getRuntime]
  )

  /**
   * Run Image-to-Image inference (Upscale, Colorize).
   */
  const runImageToImage = useCallback(
    async (
      imgEl: HTMLImageElement,
      modelKey: ModelKey,
      onUpdate: ProgressCallback,
      options: { size?: number; quality?: number } = {}
    ): Promise<Blob> => {
      const ort = await getRuntime()
      const session = await getOrCreateSession(modelKey, onUpdate)

      const isColorizer = modelKey.includes("deoldify")
      const isUpscaler =
        modelKey.includes("swin2sr") || modelKey.includes("realesrgan")
      const quality = options.quality ?? 0.9

      onUpdate("Pre-processing…", 0)
      // Note: The current DeOldify ONNX models have a fixed input size of 256x256.
      const size = isColorizer ? 256 : options.size || 512
      const inputTensor = preprocessImageToImage(imgEl, ort, size, {
        keepAspectRatio: isColorizer,
        grayscale: isColorizer,
        useByteRange: isColorizer,
      })

      onUpdate("Running inference…", 0)
      const inputType = MODELS[modelKey].inputType
      const results = await withTimeout(
        session.run({ [inputType]: inputTensor }),
        INFERENCE_TIMEOUT_MS,
        "Inference timed out."
      )

      onUpdate("Post-processing…", 0)
      const outputTensor = results[session.outputNames[0]]

      if (isColorizer) {
        return applyColorizerChromaToOriginal(outputTensor, imgEl, quality)
      }

      // For upscaler, output size is usually input * 4
      const outW =
        (outputTensor.dims[3] as number) ||
        (options.size || 512) * (isUpscaler ? 4 : 1)
      const outH =
        (outputTensor.dims[2] as number) ||
        (options.size || 512) * (isUpscaler ? 4 : 1)

      const blob = await tensorToImageData(outputTensor, outW, outH, {
        quality,
      })

      return blob
    },
    [getOrCreateSession, getRuntime]
  )

  return {
    modelStatus,
    downloadProgress,
    runInference,
    runImageToImage,
    setModelStatus,
  }
}
