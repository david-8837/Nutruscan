import { Capacitor, registerPlugin } from "@capacitor/core";

const StepCounter = registerPlugin("StepCounter");

export const supportsNativeStepCounter = () => {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
};

export async function startNativeStepCounter(onUpdate) {
  if (!supportsNativeStepCounter()) return { ok: false, reason: "platform" };

  const status = await StepCounter.getStatus().catch(() => null);
  if (!status?.available) return { ok: false, reason: "unavailable" };

  const perm = await StepCounter.requestPermission().catch(() => null);
  if (!perm?.permissionGranted) return { ok: false, reason: "permission" };

  const listenerHandle = await StepCounter.addListener("stepCounterUpdate", (payload) => {
    const totalSteps = Math.max(0, Math.round(+payload?.totalSteps || 0));
    onUpdate && onUpdate(totalSteps);
  });

  const started = await StepCounter.startTracking().catch(() => null);
  if (!started?.started && !started?.listening) {
    await listenerHandle.remove().catch(() => null);
    return { ok: false, reason: "start-failed" };
  }

  const current = await StepCounter.getStatus().catch(() => null);
  const initialTotalSteps = current && current.totalSteps >= 0 ? Math.round(+current.totalSteps || 0) : null;

  return {
    ok: true,
    initialTotalSteps,
    stop: async () => {
      await listenerHandle.remove().catch(() => null);
      await StepCounter.stopTracking().catch(() => null);
    },
  };
}
