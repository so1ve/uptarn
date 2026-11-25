<script lang="ts"></script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { useUptarnStore } from "../../lib/index.ts";

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      "sitekey": string;
      "action"?: string;
      "theme"?: "light" | "dark" | "auto";
      "size"?: "normal" | "flexible" | "compact";
      "callback"?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

const props = withDefaults(
  defineProps<{
    siteKey: string;
    action?: string;
  }>(),
  { action: "login" },
);
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<TurnstileApi> | null = null;

const getTurnstile = (): TurnstileApi | undefined =>
  (window as { turnstile?: TurnstileApi }).turnstile;

function loadTurnstileScript(): Promise<TurnstileApi> {
  const existing = getTurnstile();
  if (existing) {
    return Promise.resolve(existing);
  }
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      const api = getTurnstile();
      if (api) {
        resolve(api);
      } else {
        scriptPromise = null;
        reject(new Error("Turnstile failed to initialize"));
      }
    });
    script.addEventListener("error", () => {
      scriptPromise = null;
      reject(new Error("Failed to load Turnstile script"));
    });
    document.head.appendChild(script);
  });

  return scriptPromise;
}

const token = defineModel<string>({ default: "" });
const { isDark } = useUptarnStore();

const containerRef = ref<HTMLElement | null>(null);
const loadError = ref<string | null>(null);
let widgetId: string | null = null;
let mounted = false;

function cleanup() {
  if (widgetId !== null) {
    getTurnstile()?.remove(widgetId);
    widgetId = null;
  }
}

async function renderWidget() {
  cleanup();
  token.value = "";
  loadError.value = null;

  let api: TurnstileApi;
  try {
    api = await loadTurnstileScript();
  } catch (err) {
    loadError.value =
      err instanceof Error ? err.message : "Verification widget unavailable";

    return;
  }
  if (!mounted || !containerRef.value) {
    return;
  }
  widgetId = api.render(containerRef.value, {
    "sitekey": props.siteKey,
    "action": props.action,
    "theme": isDark.value ? "dark" : "light",
    "size": "flexible",
    "callback": (nextToken) => {
      token.value = nextToken;
      loadError.value = null;
    },
    "expired-callback": () => {
      token.value = "";
    },
    "error-callback": () => {
      token.value = "";
    },
  });
}

function reset() {
  token.value = "";
  if (widgetId !== null) {
    getTurnstile()?.reset(widgetId);
  }
}

defineExpose({ reset });

onMounted(() => {
  mounted = true;
  void renderWidget();
});

watch([() => props.siteKey, isDark], () => {
  if (mounted) {
    void renderWidget();
  }
});

onBeforeUnmount(() => {
  mounted = false;
  cleanup();
});
</script>

<template>
  <div class="min-h-[65px]">
    <div ref="containerRef" />
    <p v-if="loadError" class="text-xs text-red-500 dark:text-red-400">
      {{ loadError }}
    </p>
  </div>
</template>
