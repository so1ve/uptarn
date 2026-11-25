<script setup lang="ts">
import BrandMark from "../components/ui/BrandMark.vue";
import type { SiteLink } from "../lib/index.ts";
import { useUptarnStore } from "../lib/index.ts";

defineProps<{
  version: string;
  title?: string | null;
  links?: readonly SiteLink[];
  host?: string;
  homeTo?: string;
}>();

const { isDark, toggleTheme } = useUptarnStore();
const isDemo = import.meta.env.VITE_DEMO === "true";
</script>

<template>
  <div class="flex min-h-svh flex-col">
    <header
      class="sticky top-0 z-10 border-b border-default bg-default/85 backdrop-blur-md"
    >
      <div
        class="mx-auto flex max-w-[1160px] flex-wrap items-center justify-between gap-x-4 px-4 sm:px-5 md:h-14 md:flex-nowrap md:gap-x-6"
      >
        <div class="flex h-13 min-w-0 items-center md:h-auto">
          <BrandMark :host :title :to="homeTo" />
        </div>

        <div
          v-if="$slots.nav"
          class="order-3 -mx-4 flex w-[calc(100%+2rem)] items-center overflow-x-auto border-t border-default/70 px-4 py-1.5 sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5 md:order-2 md:mx-0 md:mr-auto md:w-auto md:overflow-visible md:border-t-0 md:p-0"
        >
          <slot name="nav" />
        </div>
        <nav
          v-else-if="links && links.length > 0"
          aria-label="External links"
          class="order-3 -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto border-t border-default/70 px-4 py-1.5 sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5 md:order-2 md:mx-0 md:mr-auto md:w-auto md:overflow-visible md:border-t-0 md:p-0"
        >
          <a
            v-for="link in links"
            :key="`${link.label}:${link.url}`"
            class="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-muted transition-colors hover:bg-elevated/70 hover:text-default"
            :href="link.url"
            rel="noopener noreferrer"
            target="_blank"
          >
            <span>{{ link.label }}</span>
            <UIcon class="size-3 text-dimmed" name="i-lucide-arrow-up-right" />
          </a>
        </nav>

        <div
          class="order-2 flex h-13 shrink-0 items-center gap-1 md:order-3 md:h-auto"
        >
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

    <main
      class="mx-auto w-full max-w-[1160px] flex-1 px-4 pt-6 pb-12 sm:px-5 sm:pt-7"
    >
      <slot />
    </main>

    <footer class="mx-auto w-full max-w-[1160px] px-4 pb-8 sm:px-5">
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4 font-mono text-xs text-dimmed"
      >
        <div class="flex items-center gap-1.5">
          <a
            class="transition-colors hover:text-highlighted"
            href="https://github.com/so1ve/uptarn"
            rel="noopener noreferrer"
            target="_blank"
          >
            Uptarn
          </a>
          <span>v{{ version }}</span>
          <span v-if="isDemo" class="font-sans text-muted">
            · Interactive demo (resets on reload)
          </span>
        </div>
        <div
          v-if="links && links.length > 0"
          class="flex flex-wrap items-center gap-x-4 gap-y-1 font-sans"
        >
          <a
            v-for="link in links"
            :key="`footer:${link.label}:${link.url}`"
            class="transition-colors hover:text-highlighted"
            :href="link.url"
            rel="noopener noreferrer"
            target="_blank"
          >
            {{ link.label }}
          </a>
        </div>
      </div>
    </footer>
  </div>
</template>
