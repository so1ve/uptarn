<script setup lang="ts">
import BrandMark from "./BrandMark.vue";

defineProps<{
  variant: "public" | "admin-cards" | "admin-list";
}>();

const NAV_WIDTHS = ["w-14", "w-16", "w-11", "w-16", "w-24"] as const;
const MONITOR_ROWS = [
  { name: "w-24", sub: "w-32" },
  { name: "w-32", sub: "w-24" },
  { name: "w-20", sub: "w-28" },
  { name: "w-28", sub: "w-24" },
] as const;
const LIST_ROWS = [
  { name: "w-36", sub: "w-48" },
  { name: "w-28", sub: "w-40" },
  { name: "w-44", sub: "w-36" },
  { name: "w-32", sub: "w-52" },
  { name: "w-40", sub: "w-44" },
] as const;
</script>

<template>
  <div aria-busy="true" class="flex min-h-svh flex-col">
    <span class="sr-only">Loading</span>

    <header
      class="sticky top-0 z-10 border-b border-default bg-default/85 backdrop-blur-md"
    >
      <div
        class="mx-auto flex h-13 max-w-[1160px] items-center justify-between gap-x-4 px-4 sm:px-5 lg:h-14 lg:gap-x-6"
      >
        <BrandMark />

        <div
          v-if="variant !== 'public'"
          class="mr-auto hidden items-center gap-1 lg:flex"
        >
          <USkeleton
            v-for="(width, idx) in NAV_WIDTHS"
            :key="idx"
            class="h-8 rounded-md"
            :class="width"
          />
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <USkeleton class="size-8 rounded-md" />
          <USkeleton class="h-8 w-16 rounded-md" />
        </div>
      </div>
    </header>

    <main
      class="mx-auto w-full max-w-[1160px] flex-1 space-y-8 px-4 pt-6 pb-12 sm:px-5 sm:pt-7"
    >
      <template v-if="variant === 'public'">
        <div
          class="flex items-center justify-between gap-3 rounded-xl border border-default bg-surface px-4 py-3"
        >
          <div class="flex items-center gap-2.5">
            <USkeleton class="size-2.5 rounded-full" />
            <USkeleton class="h-4 w-44" />
          </div>
          <USkeleton class="hidden h-3.5 w-24 sm:block" />
        </div>

        <section class="space-y-3">
          <div class="flex items-center justify-between gap-3">
            <USkeleton class="h-4 w-16" />
            <USkeleton class="h-7 w-28 rounded-lg" />
          </div>

          <div class="divide-y divide-default border-y border-default">
            <div
              v-for="(row, idx) in MONITOR_ROWS"
              :key="idx"
              class="flex flex-col gap-2.5 px-2 py-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <div
                class="flex min-w-0 items-center gap-2.5 sm:w-52 sm:shrink-0"
              >
                <USkeleton class="size-2 shrink-0 rounded-full" />
                <div class="min-w-0 space-y-1.5">
                  <USkeleton class="h-3.5" :class="row.name" />
                  <USkeleton class="h-3" :class="row.sub" />
                </div>
              </div>
              <USkeleton class="h-6 w-full flex-1 rounded-[3px]" />
              <div class="hidden shrink-0 items-center gap-4 sm:flex">
                <USkeleton class="h-3.5 w-11" />
                <USkeleton class="h-3.5 w-14" />
              </div>
            </div>
          </div>
        </section>
      </template>

      <div v-else class="flex items-center justify-between gap-3">
        <USkeleton class="h-6 w-24" />
        <USkeleton class="h-8 w-24 rounded-md" />
      </div>

      <section v-if="variant !== 'admin-list'" class="space-y-3">
        <USkeleton v-if="variant === 'public'" class="h-4 w-14" />
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="n in 3"
            :key="n"
            class="space-y-4 rounded-xl border border-default bg-surface p-4"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <USkeleton class="size-2 rounded-full" />
                <USkeleton class="h-4 w-24" />
              </div>
              <USkeleton class="h-3.5 w-16" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-2">
                <USkeleton class="h-3 w-12" />
                <USkeleton class="h-7 w-full rounded-md" />
              </div>
              <div class="space-y-2">
                <USkeleton class="h-3 w-14" />
                <USkeleton class="h-7 w-full rounded-md" />
              </div>
            </div>
            <USkeleton class="h-2 w-full rounded-full" />
          </div>
        </div>
      </section>

      <div v-else class="divide-y divide-default border-y border-default">
        <div
          v-for="(row, idx) in LIST_ROWS"
          :key="idx"
          class="flex items-center justify-between gap-4 px-2 py-3.5"
        >
          <div class="flex min-w-0 items-center gap-2.5">
            <USkeleton class="size-2 shrink-0 rounded-full" />
            <div class="space-y-1.5">
              <USkeleton class="h-3.5" :class="row.name" />
              <USkeleton class="h-3" :class="row.sub" />
            </div>
          </div>
          <USkeleton class="h-4 w-16 shrink-0" />
        </div>
      </div>
    </main>
  </div>
</template>
