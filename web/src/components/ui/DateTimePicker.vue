<script setup lang="ts">
import type { DateValue } from "@internationalized/date";
import {
  CalendarDate,
  CalendarDateTime,
  fromDate,
  getLocalTimeZone,
  toCalendarDateTime,
} from "@internationalized/date";
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    size?: "xs" | "sm" | "md";
    clearable?: boolean;
    ariaLabel?: string;
  }>(),
  {
    size: "sm",
    clearable: false,
    ariaLabel: "Date and time",
  },
);

const model = defineModel<number | null>({ default: null });
const calendarOpen = ref(false);
const tz = getLocalTimeZone();

function unixToCalendarDateTime(secs: number): CalendarDateTime {
  const zoned = fromDate(new Date(secs * 1000), tz);

  return new CalendarDateTime(
    zoned.year,
    zoned.month,
    zoned.day,
    zoned.hour,
    zoned.minute,
  );
}

const calendarDateTimeToUnix = (val: DateValue): number =>
  Math.floor(val.toDate(tz).getTime() / 1000);

const dateTimeValue = computed<CalendarDateTime | undefined>({
  get: () =>
    model.value === null ? undefined : unixToCalendarDateTime(model.value),
  set: (val) => {
    model.value = val ? calendarDateTimeToUnix(val) : null;
  },
});

const calendarDateValue = computed<CalendarDate | undefined>({
  get: () => {
    const dt = dateTimeValue.value;

    return dt ? new CalendarDate(dt.year, dt.month, dt.day) : undefined;
  },
  set: (val) => {
    if (!val) {
      return;
    }
    const base =
      dateTimeValue.value ??
      unixToCalendarDateTime(Math.floor(Date.now() / 1000));
    const merged = toCalendarDateTime(
      new CalendarDate(val.year, val.month, val.day),
    ).set({ hour: base.hour, minute: base.minute });
    model.value = calendarDateTimeToUnix(merged);
    calendarOpen.value = false;
  },
});
</script>

<template>
  <UInputDate
    v-model="dateTimeValue"
    :aria-label="props.ariaLabel"
    class="font-mono tabular-nums"
    granularity="minute"
    :hour-cycle="24"
    :size="props.size"
    :ui="{
      base: props.clearable && model !== null ? 'pe-14' : 'pe-9',
    }"
  >
    <template #trailing>
      <div class="flex items-center gap-0.5">
        <UButton
          v-if="props.clearable && model !== null"
          aria-label="Clear date and time"
          color="neutral"
          icon="i-lucide-x"
          size="xs"
          type="button"
          variant="link"
          @click="model = null"
        />
        <UPopover v-model:open="calendarOpen" :ui="{ content: 'z-[100]' }">
          <UButton
            aria-label="Pick date from calendar"
            color="neutral"
            icon="i-lucide-calendar"
            size="xs"
            type="button"
            variant="link"
          />
          <template #content>
            <UCalendar v-model="calendarDateValue" class="p-2" size="sm" />
          </template>
        </UPopover>
      </div>
    </template>
  </UInputDate>
</template>
