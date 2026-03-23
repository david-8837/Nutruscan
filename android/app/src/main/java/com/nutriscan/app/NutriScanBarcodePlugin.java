package com.nutriscan.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Stub implementation - native barcode scanning disabled
@CapacitorPlugin(name = "NutriScanBarcode")
public class NutriScanBarcodePlugin extends Plugin {

    @PluginMethod
    public void startScan(PluginCall call) {
        // Web-based fallback is used instead in React
        call.reject("Native barcode scanning not available");
    }
}
