<script setup lang="ts">
import BrandMark from "../components/ui/BrandMark.vue";
import { useUptarnStore } from "../lib/index.ts";

defineProps<{
  version: string;
  host?: string;
  homeTo?: string;
}>();

const { isDark, toggleTheme } = useUptarnStore();
</script>

<template>
  <div class="flex min-h-svh flex-col">
    <header
      class="sticky top-0 z-10 border-b border-default bg-default/85 backdrop-blur-md"
    >
      <div
        class="mx-auto flex min-h-14 max-w-[1160px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-2"
      >
        <div class="flex min-w-0 items-center gap-6">
          <BrandMark :host :to="homeTo" />
          <slot name="nav" />
        </div>

        <div class="flex items-center gap-1">
          <slot name="actions-prefix" />
          <UButton
            aria-label="Toggle theme"
            color="neutral"
            :icon="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
            size="sm"
            variant="ghost"
            @click="toggleTheme"
          />
          <slot name="actions" />
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-[1160px] flex-1 px-5 pt-7 pb-12">
      <slot />
    </main>

    <footer class="mx-auto w-full max-w-[1160px] px-5 pb-8">
      <div
        class="flex items-center gap-1.5 border-t border-default pt-4 font-mono text-xs text-dimmed"
      >
        <a
          class="transition-colors hover:text-highlighted"
          href="https://github.com/so1ve/uptarn"
          rel="noopener noreferrer"
          target="_blank"
        >
          Uptarn
        </a>
        <span>v{{ version }}</span>
      </div>
    </footer>
  </div>
</template>
