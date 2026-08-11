/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker"
import {
  NetworkOnly,
  Serwist,
  type PrecacheEntry,
  type RuntimeCaching,
  type SerwistGlobalConfig,
} from "serwist"

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (string | { url: string; revision: string })[]
  }
}

declare const self: ServiceWorkerGlobalScope

const isAiAssetUrl = (url: URL) =>
  url.hostname === "huggingface.co" ||
  url.hostname.endsWith(".hf.co") ||
  (url.hostname === "cdn.jsdelivr.net" &&
    url.pathname.includes("/onnxruntime-web@"))

const aiAssetsNetworkOnly: RuntimeCaching = {
  matcher: ({ url }) => isAiAssetUrl(url),
  handler: new NetworkOnly(),
}

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Models already have a dedicated IndexedDB cache. Keeping a second copy in
  // Cache Storage can exhaust the browser quota and make processing fail.
  runtimeCaching: [aiAssetsNetworkOnly, ...defaultCache],
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document"
        },
      },
    ],
  },
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.open("cross-origin").then(async (cache) => {
      const requests = await cache.keys()
      await Promise.all(
        requests
          .filter((request) => isAiAssetUrl(new URL(request.url)))
          .map((request) => cache.delete(request))
      )
    })
  )
})

serwist.addEventListeners()
