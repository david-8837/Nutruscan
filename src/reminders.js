import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

const CHANNEL_ID = "nutriscan-reminders";
const MEAL_IDS = [1001, 1002, 1003];
const WATER_IDS = [2100, 2101, 2102, 2103, 2104, 2105, 2106, 2107];
const ALL_IDS = [...MEAL_IDS, ...WATER_IDS];

/**
 * Syncs daily meal + water local notifications from Settings toggles.
 * No-op on web / non-native builds.
 */
export async function syncMealWaterReminders({ mealReminders, waterReminders }) {
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
          title: "🌅 Breakfast",
          body: "Log your breakfast in NutriScan",
          channelId: CHANNEL_ID,
          schedule: { every: "day", on: { hour: 9, minute: 0 } },
        },
        {
          id: 1002,
          title: "☀️ Lunch",
          body: "Log your lunch in NutriScan",
          channelId: CHANNEL_ID,
          schedule: { every: "day", on: { hour: 13, minute: 0 } },
        },
        {
          id: 1003,
          title: "🌙 Dinner",
          body: "Log your dinner in NutriScan",
          channelId: CHANNEL_ID,
          schedule: { every: "day", on: { hour: 20, minute: 0 } },
        }
      );
    }

    if (waterReminders) {
      [8, 10, 12, 14, 16, 18, 20, 22].forEach((hour, i) => {
        notifications.push({
          id: WATER_IDS[i],
          title: "💧 Hydration",
          body: "Time for water — tap NutriScan to log a glass",
          channelId: CHANNEL_ID,
          schedule: { every: "day", on: { hour, minute: 0 } },
        });
      });
    }

    if (notifications.length) await LocalNotifications.schedule({ notifications });
  } catch (e) {
    /* fail silently */
  }
}
