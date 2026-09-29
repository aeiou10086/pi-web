/**
 * Client-side Web Push subscription. Called once when the Notification
 * permission is granted; silently no-ops on unsupported browsers (e.g. iOS
 * Safari < 16.4 or non-PWA contexts) so the existing in-page notification
 * path keeps working as a fallback.
 */

let activeSubscriptionPromise: Promise<boolean> | null = null;

// Standard base64url → Uint8Array conversion for applicationServerKey.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export async function setupPushSubscription(locale: string): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== "granted") return false;
  if (activeSubscriptionPromise) return activeSubscriptionPromise;

  const attempt = (async () => {
    const configResponse = await fetch("/api/push/config");
    if (!configResponse.ok) throw new Error(`push/config HTTP ${configResponse.status}`);
    const { publicKey } = await configResponse.json() as { publicKey?: string };
    if (!publicKey) throw new Error("push/config 未返回 publicKey");

    let registration: ServiceWorkerRegistration;
    try {
      registration = await navigator.serviceWorker.ready;
    } catch (error) {
      throw new Error(`Service Worker 未就绪: ${error instanceof Error ? error.message : String(error)}`);
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      try {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      } catch (error) {
        throw new Error(`pushManager.subscribe 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON(), locale }),
    });
    if (!response.ok) throw new Error(`push/subscribe HTTP ${response.status}`);
    return true;
  })();

  activeSubscriptionPromise = attempt;
  void attempt.then(
    () => {},
    () => { if (activeSubscriptionPromise === attempt) activeSubscriptionPromise = null; },
  );
  return attempt;
}
