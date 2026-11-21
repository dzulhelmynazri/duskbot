import "../../../electron/legacy-names.mjs";
import { Capacitor } from "@capacitor/core";
import { mountMobile } from "@/mobile/boot";
import { webPlatform } from "@/mobile/platform";
import { nativePlatform } from "./native-platform";
import { createErrorReporter } from "../../../electron/error-report.mjs";

const errors = createErrorReporter({ dsn: __MADANI_ERROR_DSN__, component: "mobile", release: __APP_VERSION__ });
if (errors.enabled) {
  addEventListener("error", (event) => errors.capture(event.error ?? event.message));
  addEventListener("unhandledrejection", (event) => errors.capture(event.reason));
}

const platform = Capacitor.isNativePlatform() ? await nativePlatform() : webPlatform();
mountMobile(platform);
