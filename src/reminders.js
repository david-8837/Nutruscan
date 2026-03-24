import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

const CHANNEL_ID = "nutriscan-reminders";
const SCHEDULE_DAYS_AHEAD = 14;
const MEAL_BASE_ID = 100000;
const WATER_BASE_ID = 200000;
const SLEEP_BASE_ID = 300000;
const CONTEXT_IDS = [3101, 3102, 3103, 3201, 3202, 3301, 3401, 3501, 3602, 3603, 3604];
const MEAL_SLOTS = [
  { key: "breakfast", hour: 8, minute: 0, title: "🌅 Log your breakfast!", body: "Start your day right — log what you ate" },
  { key: "lunch", hour: 13, minute: 0, title: "☀️ Lunch time!", body: "Don't forget to log your lunch" },
  { key: "dinner", hour: 19, minute: 30, title: "🌙 Dinner time!", body: "Log your dinner to stay on track" },
];
const WATER_SLOTS = [7, 9, 11, 13, 15, 17, 19, 21];
const IN_TIME_FMT = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const formatTime12 = (hour, minute = 0) => {
  const dt = new Date();
  dt.setHours(hour, minute, 0, 0);
  return IN_TIME_FMT.format(dt);
};

const atToday = (hour, minute = 0) => {
  const dt = new Date();
  dt.setHours(hour, minute, 0, 0);
  return dt;
};

const atDay = (dayOffset, hour, minute = 0) => {
  const dt = new Date();
  dt.setDate(dt.getDate() + dayOffset);
  dt.setHours(hour, minute, 0, 0);
  return dt;
};

const isFuture = (dateObj) => dateObj.getTime() > Date.now() + 1000;

const soon = (seconds = 2) => new Date(Date.now() + Math.max(1, seconds) * 1000);

const hasMealType = (meals, type) =>
  Array.isArray(meals) && meals.some((m) => String(m?.m || "").toLowerCase() === String(type || "").toLowerCase());

const mealNotificationId = (dayOffset, slotIndex) => MEAL_BASE_ID + (dayOffset * 10) + slotIndex;
const waterNotificationId = (dayOffset, slotIndex) => WATER_BASE_ID + (dayOffset * 10) + slotIndex;
const sleepNotificationId = (dayOffset) => SLEEP_BASE_ID + dayOffset;

const buildCancellableIds = () => {
  const ids = [...CONTEXT_IDS];
  for (let day = 0; day < SCHEDULE_DAYS_AHEAD; day += 1) {
    for (let i = 0; i < MEAL_SLOTS.length; i += 1) ids.push(mealNotificationId(day, i));
    for (let i = 0; i < WATER_SLOTS.length; i += 1) ids.push(waterNotificationId(day, i));
    ids.push(sleepNotificationId(day));
  }
  return ids;
};

const ensureNotificationAccess = async () => {
  const current = await LocalNotifications.checkPermissions();
  if (current.display !== "granted") {
    const asked = await LocalNotifications.requestPermissions();
    if (asked.display !== "granted") return false;
  }
  if (typeof LocalNotifications.checkExactNotificationSetting === "function") {
    const exact = await LocalNotifications.checkExactNotificationSetting().catch(() => null);
    if (exact?.value === "disabled" && typeof LocalNotifications.changeExactNotificationSetting === "function") {
      await LocalNotifications.changeExactNotificationSetting().catch(() => null);
    }
  }
  return true;
};

const baseSchedule = (at) => ({ at, allowWhileIdle: true });

/**
 * Syncs daily meal + water local notifications from Settings toggles.
 * Includes conditional notifications for meal logging, calorie goals, and streaks.
 * No-op on web / non-native builds.
 */
export async function syncMealWaterReminders({ 
  mealReminders, 
  waterReminders, 
  sleepReminderEnabled = false,
  sleepReminderHour = 22,
  sleepReminderMinute = 30,
  meals = [], 
  water = 0,
  caloriesEaten = 0,
  calorieTarget = 2000,
  currentStreak = 0,
  streakJustHit7 = false
}) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const cancellableIds = buildCancellableIds();
    await LocalNotifications.cancel({
      notifications: cancellableIds.map((id) => ({ id })),
    });
    if (!mealReminders && !waterReminders && !sleepReminderEnabled) return;

    const hasAccess = await ensureNotificationAccess();
    if (!hasAccess) return;

    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: "Meal & water reminders",
      description: "Gentle nudges to log meals and water in NutriScan",
      importance: 4,
      visibility: 1,
    });

    const notifications = [];

    if (mealReminders) {
      for (let day = 0; day < SCHEDULE_DAYS_AHEAD; day += 1) {
        MEAL_SLOTS.forEach((slot, slotIndex) => {
          const at = atDay(day, slot.hour, slot.minute);
          if (!isFuture(at)) return;
          notifications.push({
            id: mealNotificationId(day, slotIndex),
            title: slot.title,
            body: slot.body,
            channelId: CHANNEL_ID,
            schedule: baseSchedule(at),
          });
        });
      }
    }

    if (waterReminders) {
      for (let day = 0; day < SCHEDULE_DAYS_AHEAD; day += 1) {
        WATER_SLOTS.forEach((hour, slotIndex) => {
          const at = atDay(day, hour, 0);
          if (!isFuture(at)) return;
          notifications.push({
            id: waterNotificationId(day, slotIndex),
            title: `💧 Water reminder`,
            body: "Time to hydrate — tap NutriScan to log a glass of water",
            channelId: CHANNEL_ID,
            schedule: baseSchedule(at),
          });
        });
      }
    }

    if (sleepReminderEnabled) {
      const sleepHour = Number.isFinite(+sleepReminderHour) ? Math.min(23, Math.max(0, +sleepReminderHour)) : 22;
      const sleepMinute = Number.isFinite(+sleepReminderMinute) ? Math.min(59, Math.max(0, +sleepReminderMinute)) : 30;
      for (let day = 0; day < SCHEDULE_DAYS_AHEAD; day += 1) {
        const at = atDay(day, sleepHour, sleepMinute);
        if (!isFuture(at)) continue;
        notifications.push({
          id: sleepNotificationId(day),
          title: `😴 Sleep reminder`,
          body: `Wind down and sleep on time (${formatTime12(sleepHour, sleepMinute)}).`,
          channelId: CHANNEL_ID,
          schedule: baseSchedule(at),
        });
      }
    }

    const hasBreakfast = hasMealType(meals, "Breakfast");
    const hasLunch = hasMealType(meals, "Lunch");
    const hasDinner = hasMealType(meals, "Dinner");
    const hasAnyMeal = Array.isArray(meals) && meals.length > 0;

    if (mealReminders) {
      const breakfastMissAt = atToday(9, 30);
      const lunchMissAt = atToday(14, 30);
      const dinnerMissAt = atToday(20, 30);
      const noLogAfternoonAt = atToday(14, 0);
      const noLogNightAt = atToday(21, 0);
      const closeoutAt = atToday(21, 20);
      const prepAt = atToday(21, 30);

      if (!hasBreakfast && isFuture(breakfastMissAt)) {
        notifications.push({
          id: 3101,
          title: `🌅 Time to log breakfast!`,
          body: "It's morning and no breakfast logged yet",
          channelId: CHANNEL_ID,
          schedule: baseSchedule(breakfastMissAt),
        });
      }

      if (!hasLunch && isFuture(lunchMissAt)) {
        notifications.push({
          id: 3102,
          title: `☀️ Log your lunch!`,
          body: "Don't forget to track your midday meal",
          channelId: CHANNEL_ID,
          schedule: baseSchedule(lunchMissAt),
        });
      }

      if (!hasDinner && isFuture(dinnerMissAt)) {
        notifications.push({
          id: 3103,
          title: `🌙 Log your dinner!`,
          body: "Almost end of day — track your last meal",
          channelId: CHANNEL_ID,
          schedule: baseSchedule(dinnerMissAt),
        });
      }

      if (!hasAnyMeal && isFuture(noLogAfternoonAt)) {
        notifications.push({
          id: 3201,
          title: `📝 No log yet • ${formatTime12(14, 0)}`,
          body: "You haven't logged any meal yet today.",
          channelId: CHANNEL_ID,
          schedule: baseSchedule(noLogAfternoonAt),
        });
      }

      if ((!hasAnyMeal || !hasDinner) && isFuture(noLogNightAt)) {
        notifications.push({
          id: 3202,
          title: `📝 Gentle nudge • ${formatTime12(21, 0)}`,
          body: "No dinner log yet — add your meal to complete today.",
          channelId: CHANNEL_ID,
          schedule: baseSchedule(noLogNightAt),
        });
      }

      if (!hasDinner && isFuture(closeoutAt)) {
        notifications.push({
          id: 3401,
          title: `🌙 Day closeout • ${formatTime12(21, 20)}`,
          body: "Log your dinner/last meal before day ends.",
          channelId: CHANNEL_ID,
          schedule: baseSchedule(closeoutAt),
        });
      }

      if (isFuture(prepAt)) {
        notifications.push({
          id: 3501,
          title: `🗓️ Next-day prep • ${formatTime12(21, 30)}`,
          body: "Set a quick plan for tomorrow's meals.",
          channelId: CHANNEL_ID,
          schedule: baseSchedule(prepAt),
        });
      }
    }

    if (waterReminders) {
      const hydrationCatchUpAt = atToday(18, 30);
      if (+water < 6 && isFuture(hydrationCatchUpAt)) {
        notifications.push({
          id: 3301,
          title: `💧 Catch-up • ${formatTime12(18, 30)}`,
          body: `Water is low (${water} glasses). Let's catch up this evening.`,
          channelId: CHANNEL_ID,
          schedule: baseSchedule(hydrationCatchUpAt),
        });
      }
    }

    if (caloriesEaten > 0 && calorieTarget > 0) {
      if (caloriesEaten > calorieTarget) {
        const overAmount = caloriesEaten - calorieTarget;
        notifications.push({
          id: 3602,
          title: `⚠️ Over your goal!`,
          body: `You're ${Math.round(overAmount)} kcal over today's target`,
          channelId: CHANNEL_ID,
          schedule: baseSchedule(soon(2)),
        });
      }
      else if (caloriesEaten >= calorieTarget * 0.95) {
        const remainingAmount = calorieTarget - caloriesEaten;
        notifications.push({
          id: 3603,
          title: `🎯 Almost at your goal!`,
          body: `Just ${Math.round(remainingAmount)} kcal away from your target`,
          channelId: CHANNEL_ID,
          schedule: baseSchedule(soon(2)),
        });
      }
    }

    if (streakJustHit7) {
      notifications.push({
        id: 3604,
        title: `🔥 7-day streak!`,
        body: `Amazing consistency — keep it up!`,
        channelId: CHANNEL_ID,
        schedule: baseSchedule(soon(2)),
      });
    }

    if (notifications.length) await LocalNotifications.schedule({ notifications });
  } catch (e) {
    /* fail silently */
  }
}

export async function scheduleDailyReminderExample({
  id = 3901,
  title = "⏰ Daily reminder",
  body = "It's 2:00 PM — time for your NutriScan reminder.",
  hour = 14,
  minute = 0,
} = {}) {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const hasAccess = await ensureNotificationAccess();
    if (!hasAccess) return false;

    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: "Meal & water reminders",
      description: "Gentle nudges to log meals and water in NutriScan",
      importance: 4,
      visibility: 1,
    });

    await LocalNotifications.cancel({ notifications: [{ id }] }).catch(() => null);

    const todayAt = atToday(hour, minute);
    const fireAt = isFuture(todayAt) ? todayAt : atDay(1, hour, minute);

    await LocalNotifications.schedule({
      notifications: [{
        id,
        title,
        body,
        channelId: CHANNEL_ID,
        schedule: baseSchedule(fireAt),
      }],
    });

    return true;
  } catch {
    return false;
  }
}
