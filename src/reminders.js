import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

const CHANNEL_ID = "nutriscan-reminders";
const MEAL_IDS = [1001, 1002, 1003];
const WATER_IDS = [2100, 2101, 2102, 2103, 2104, 2105, 2106];
const CONTEXT_IDS = [3101, 3102, 3103, 3201, 3202, 3301, 3401, 3501];
const ALL_IDS = [...MEAL_IDS, ...WATER_IDS, ...CONTEXT_IDS];
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

const isFuture = (dateObj) => dateObj.getTime() > Date.now() + 1000;

const hasMealType = (meals, type) =>
  Array.isArray(meals) && meals.some((m) => String(m?.m || "").toLowerCase() === String(type || "").toLowerCase());

/**
 * Syncs daily meal + water local notifications from Settings toggles.
 * No-op on web / non-native builds.
 */
export async function syncMealWaterReminders({ mealReminders, waterReminders, meals = [], water = 0 }) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({
      notifications: ALL_IDS.map((id) => ({ id })),
    });
    if (!mealReminders && !waterReminders) return;

    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") return;

    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: "Meal & water reminders",
      description: "Gentle nudges to log meals and water in NutriScan",
      importance: 4,
      visibility: 1,
    });

    const notifications = [];

    if (mealReminders) {
      notifications.push(
        {
          id: 1001,
          title: `🌅 Breakfast • ${formatTime12(9, 0)}`,
          body: "Start your day strong — log breakfast in NutriScan.",
          channelId: CHANNEL_ID,
          schedule: { every: "day", on: { hour: 9, minute: 0 } },
        },
        {
          id: 1002,
          title: `☀️ Lunch • ${formatTime12(13, 0)}`,
          body: "Midday check-in — log lunch and stay on track.",
          channelId: CHANNEL_ID,
          schedule: { every: "day", on: { hour: 13, minute: 0 } },
        },
        {
          id: 1003,
          title: `🌙 Dinner • ${formatTime12(20, 0)}`,
          body: "Wrap up your day by logging dinner.",
          channelId: CHANNEL_ID,
          schedule: { every: "day", on: { hour: 20, minute: 0 } },
        }
      );
    }

    if (waterReminders) {
      [9, 11, 13, 15, 17, 19, 21].forEach((hour, i) => {
        notifications.push({
          id: WATER_IDS[i],
          title: `💧 Hydration • ${formatTime12(hour, 0)}`,
          body: "Quick water break — tap NutriScan to log a glass.",
          channelId: CHANNEL_ID,
          schedule: { every: "day", on: { hour, minute: 0 } },
        });
      });
    }

    const hasBreakfast = hasMealType(meals, "Breakfast");
    const hasLunch = hasMealType(meals, "Lunch");
    const hasDinner = hasMealType(meals, "Dinner");
    const hasAnyMeal = Array.isArray(meals) && meals.length > 0;

    if (mealReminders) {
      const preBreakfastAt = atToday(8, 45);
      const preLunchAt = atToday(12, 45);
      const preDinnerAt = atToday(19, 45);
      const noLogAfternoonAt = atToday(14, 0);
      const noLogNightAt = atToday(21, 0);
      const closeoutAt = atToday(21, 20);
      const prepAt = atToday(21, 30);

      if (!hasBreakfast && isFuture(preBreakfastAt)) {
        notifications.push({
          id: 3101,
          title: `🍽️ Pre-meal • ${formatTime12(8, 45)}`,
          body: "Breakfast time is near — get ready to log your meal.",
          channelId: CHANNEL_ID,
          schedule: { at: preBreakfastAt },
        });
      }

      if (!hasLunch && isFuture(preLunchAt)) {
        notifications.push({
          id: 3102,
          title: `🍽️ Pre-meal • ${formatTime12(12, 45)}`,
          body: "Lunch is coming up — log it in NutriScan after eating.",
          channelId: CHANNEL_ID,
          schedule: { at: preLunchAt },
        });
      }

      if (!hasDinner && isFuture(preDinnerAt)) {
        notifications.push({
          id: 3103,
          title: `🍽️ Pre-meal • ${formatTime12(19, 45)}`,
          body: "Dinner window is near — remember to log your last meal.",
          channelId: CHANNEL_ID,
          schedule: { at: preDinnerAt },
        });
      }

      if (!hasAnyMeal && isFuture(noLogAfternoonAt)) {
        notifications.push({
          id: 3201,
          title: `📝 No log yet • ${formatTime12(14, 0)}`,
          body: "You haven't logged any meal yet today.",
          channelId: CHANNEL_ID,
          schedule: { at: noLogAfternoonAt },
        });
      }

      if ((!hasAnyMeal || !hasDinner) && isFuture(noLogNightAt)) {
        notifications.push({
          id: 3202,
          title: `📝 Gentle nudge • ${formatTime12(21, 0)}`,
          body: "No dinner log yet — add your meal to complete today.",
          channelId: CHANNEL_ID,
          schedule: { at: noLogNightAt },
        });
      }

      if (!hasDinner && isFuture(closeoutAt)) {
        notifications.push({
          id: 3401,
          title: `🌙 Day closeout • ${formatTime12(21, 20)}`,
          body: "Log your dinner/last meal before day ends.",
          channelId: CHANNEL_ID,
          schedule: { at: closeoutAt },
        });
      }

      if (isFuture(prepAt)) {
        notifications.push({
          id: 3501,
          title: `🗓️ Next-day prep • ${formatTime12(21, 30)}`,
          body: "Set a quick plan for tomorrow's meals.",
          channelId: CHANNEL_ID,
          schedule: { at: prepAt },
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
          schedule: { at: hydrationCatchUpAt },
        });
      }
    }

    if (notifications.length) await LocalNotifications.schedule({ notifications });
  } catch (e) {
    /* fail silently */
  }
}
