package com.nutriscan.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

@CapacitorPlugin(
    name = "StepCounter",
    permissions = {
        @Permission(alias = "activityRecognition", strings = { Manifest.permission.ACTIVITY_RECOGNITION })
    }
)
public class StepCounterPlugin extends Plugin implements SensorEventListener {

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private boolean listening = false;
    private float latestTotalSteps = -1f;

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatus());
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (isPermissionGranted()) {
            JSObject ret = new JSObject();
            ret.put("permissionGranted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("activityRecognition", call, "permissionRequestCallback");
    }

    @PluginMethod
    public void startTracking(PluginCall call) {
        if (stepCounterSensor == null || sensorManager == null) {
            call.reject("STEP_COUNTER sensor not available");
            return;
        }
        if (!isPermissionGranted()) {
            requestPermissionForAlias("activityRecognition", call, "startTrackingPermissionCallback");
            return;
        }
        registerListener();
        JSObject ret = buildStatus();
        ret.put("started", listening);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        unregisterListener();
        JSObject ret = buildStatus();
        ret.put("stopped", true);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        unregisterListener();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null || event.sensor == null || event.sensor.getType() != Sensor.TYPE_STEP_COUNTER) return;
        latestTotalSteps = event.values[0];
        JSObject payload = new JSObject();
        payload.put("totalSteps", Math.round(latestTotalSteps));
        payload.put("timestamp", System.currentTimeMillis());
        notifyListeners("stepCounterUpdate", payload, true);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    private void registerListener() {
        if (sensorManager == null || stepCounterSensor == null || listening) return;
        boolean registered = sensorManager.registerListener(this, stepCounterSensor, SensorManager.SENSOR_DELAY_UI);
        listening = registered;
    }

    private void unregisterListener() {
        if (sensorManager == null || !listening) return;
        sensorManager.unregisterListener(this);
        listening = false;
    }

    private boolean isPermissionGranted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        PermissionState state = getPermissionState("activityRecognition");
        if (state == PermissionState.GRANTED) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject buildStatus() {
        JSObject ret = new JSObject();
        ret.put("available", stepCounterSensor != null);
        ret.put("listening", listening);
        ret.put("permissionGranted", isPermissionGranted());
        ret.put("totalSteps", latestTotalSteps >= 0 ? Math.round(latestTotalSteps) : -1);
        return ret;
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void permissionRequestCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("permissionGranted", isPermissionGranted());
        if (isPermissionGranted()) call.resolve(ret);
        else call.reject("Activity recognition permission denied", "PERMISSION_DENIED", ret);
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void startTrackingPermissionCallback(PluginCall call) {
        if (!isPermissionGranted()) {
            JSObject ret = new JSObject();
            ret.put("permissionGranted", false);
            call.reject("Activity recognition permission denied", "PERMISSION_DENIED", ret);
            return;
        }
        registerListener();
        JSObject ret = buildStatus();
        ret.put("started", listening);
        call.resolve(ret);
    }
}
