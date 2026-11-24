// Maps SPACIX app manifests to external cloud AI provider endpoints and model metadata.
// Unsupported specialized pipelines remain explicitly marked so the UI shows availability honestly.
import type { App } from "../registry.ts";
import type { AppProviderBinding } from "./types.ts";

const UNSUPPORTED: Record<string, string> = {
  smoke: "Internal diagnostic test app.",
  "smoke-invert": "Internal diagnostic test app.",
  "moss-image": "MOSS-Image layout generation is currently in draft and awaiting cloud adapter support.",
  recast: "Full video actor replacement pipeline requires specialized tracking adapters not yet available on cloud providers.",
  "motion-transfer": "Body motion-transfer driving clip pipeline does not have a supported cloud endpoint yet.",
  "camera-copy": "Video camera-trajectory transfer does not have a supported cloud endpoint yet.",
  "mixed-media": "Frame-stylized multi-control video restyling does not have a supported cloud endpoint yet.",
  reframe: "Video outpainting/reframing pipeline is awaiting cloud video outpaint adapter integration.",
  "sdr-hdr": "SDR-to-HDR dynamic range video expansion does not have a supported cloud endpoint yet.",
  reshoot: "3D camera view video reshoot pipeline does not have a supported cloud endpoint yet.",
  smooth: "Optical-flow slow motion frame interpolation pipeline is awaiting cloud endpoint integration.",
  "vfx-clean-plate": "Video object removal VFX pipeline is awaiting cloud endpoint integration.",
  "vfx-day-to-night": "Video relighting day-to-night VFX pipeline is awaiting cloud endpoint integration.",
  "vfx-water": "Video water compositing VFX pipeline is awaiting cloud endpoint integration.",
  genjutsu: "Multi-reference ingredients video compositing is awaiting cloud endpoint integration.",
};

const MULTI_IMAGE_APPS = new Set([
  "character-3",
  "character-swap",
  "face-swap",
  "fashion-factory",
  "try-on",
  "outfit-swap",
  "outfit-shot",
  "moodboard",
]);

const TEXT_TO_IMAGE_APPS = new Set([
  "create-image",
  "cinema-studio",
  "ai-influencer",
  "meme",
]);

const FAL_I2V_MODEL = "LTX Video 13B";
const FAL_I2V_ENDPOINT = "fal-ai/ltx-video-13b-distilled/image-to-video";
const FAL_T2V_ENDPOINT = "fal-ai/ltx-video-13b-distilled";

export function bindingForApp(app: App): AppProviderBinding {
  if (UNSUPPORTED[app.id]) {
    return {
      supported: false,
      provider: null,
      endpoint: null,
      modelName: null,
      capability: "unsupported",
      unavailableReason: UNSUPPORTED[app.id],
    };
  }

  // Dedicated utilities
  if (app.id === "z-image") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/flux/schnell",
      modelName: "FLUX Schnell",
      capability: "text-to-image",
      unavailableReason: null,
    };
  }
  if (app.id === "inpaint") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/flux-general/inpainting",
      modelName: "FLUX Inpainting",
      capability: "inpaint",
      unavailableReason: null,
    };
  }
  if (app.id === "upscale") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/clarity-upscaler",
      modelName: "Clarity Upscaler",
      capability: "upscale",
      unavailableReason: null,
    };
  }
  if (app.id === "remove-bg") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/birefnet/v2",
      modelName: "BiRefNet v2",
      capability: "background-removal",
      unavailableReason: null,
    };
  }
  if (app.id === "depth-map") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/image-preprocessors/depth-anything/v2",
      modelName: "Depth Anything v2",
      capability: "depth",
      unavailableReason: null,
    };
  }

  // Audio generation
  if (app.id === "music") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/minimax-music",
      modelName: "MiniMax Music",
      capability: "text-to-audio",
      unavailableReason: null,
    };
  }
  if (app.id === "sfx") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/stable-audio",
      modelName: "Stable Audio",
      capability: "text-to-audio",
      unavailableReason: null,
    };
  }

  // Specialized video endpoints
  if (app.id === "talking" || app.id === "dub") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/sync-lipsync",
      modelName: "Sync LipSync",
      capability: "lip-sync",
      unavailableReason: null,
    };
  }
  if (app.id === "upscale-video") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/video-upscaler",
      modelName: "Video Upscaler",
      capability: "video-upscale",
      unavailableReason: null,
    };
  }
  if (app.id === "video-remove-bg") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/birefnet/video",
      modelName: "BiRefNet Video",
      capability: "video-background-removal",
      unavailableReason: null,
    };
  }
  if (app.id === "extend-video") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/ltx-video-13b-distilled/extend",
      modelName: FAL_I2V_MODEL,
      capability: "video-extend",
      unavailableReason: null,
    };
  }
  if (app.id === "h3-video") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/minimax/video-01",
      modelName: "MiniMax Video",
      capability: "text-to-video",
      unavailableReason: null,
    };
  }
  if (app.id === "h3-photo") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/minimax/video-01/image-to-video",
      modelName: "MiniMax Image-to-Video",
      capability: "image-to-video",
      unavailableReason: null,
    };
  }
  if (app.id === "video-t2v" || app.id === "cinema-video") {
    return {
      supported: true,
      provider: "fal",
      endpoint: FAL_T2V_ENDPOINT,
      modelName: FAL_I2V_MODEL,
      capability: "text-to-video",
      unavailableReason: null,
    };
  }

  // Video I2V apps & video templates
  if (
    app.section === "video" ||
    app.pack.startsWith("video-")
  ) {
    return {
      supported: true,
      provider: "fal",
      endpoint: FAL_I2V_ENDPOINT,
      modelName: FAL_I2V_MODEL,
      capability: "image-to-video",
      unavailableReason: null,
    };
  }

  // Image generation apps
  if (TEXT_TO_IMAGE_APPS.has(app.id)) {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/flux/dev",
      modelName: "FLUX.1 Dev",
      capability: "text-to-image",
      unavailableReason: null,
    };
  }

  if (MULTI_IMAGE_APPS.has(app.id)) {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/flux-kontext/pro",
      modelName: "FLUX Kontext Pro",
      capability: "image-to-image",
      unavailableReason: null,
    };
  }

  if (app.section === "image") {
    return {
      supported: true,
      provider: "fal",
      endpoint: "fal-ai/flux-kontext/pro",
      modelName: "FLUX Kontext Pro",
      capability: "image-to-image",
      unavailableReason: null,
    };
  }

  return {
    supported: false,
    provider: null,
    endpoint: null,
    modelName: null,
    capability: "unsupported",
    unavailableReason: "Cloud provider adapter not configured for this app.",
  };
}
