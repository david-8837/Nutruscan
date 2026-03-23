
# Supabase Auth Fix Guide (Android, Production)

App package: `com.nutriscan.app`  
Project ref: `piolbedugsubngftsrkm`

This file is the final checklist to fix both problems:

1. Google OAuth `ERR_ADDRESS_UNREACHABLE` on Android
2. Email/password signup failing with network/DNS style errors

---

## A) Fix Google OAuth redirect (no localhost)

### 1) Use this callback URL everywhere

Use exactly:

`com.nutriscan.app://login-callback`

Do not use `localhost` for mobile OAuth callback.

### 2) Supabase Dashboard URL configuration

In **Supabase → Authentication → URL Configuration**:

- **Site URL**: `com.nutriscan.app://login-callback`
- **Additional Redirect URLs**:
  - `com.nutriscan.app://login-callback`

### 3) Google Cloud Console redirect URI

In **Google Cloud Console → OAuth 2.0 Client IDs → Web client**:

- Add the **exact** redirect URI shown by Supabase Google provider page (usually Supabase callback URL for your project).
- Keep this URI exactly the same in Google and Supabase.

Then in **Supabase → Authentication → Providers → Google**:

- Enable Google
- Paste Google Client ID + Client Secret
- Save

### 4) Android deep-link intent filter

Make sure `android/app/src/main/AndroidManifest.xml` contains this inside `MainActivity`:

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data
        android:scheme="com.nutriscan.app"
        android:host="login-callback" />
</intent-filter>
```

### 5) Use OAuth with `redirect_to`

For Supabase JS (`signInWithOAuth`) use this pattern:

```ts
await supabase.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: 'com.nutriscan.app://login-callback',
    skipBrowserRedirect: true,
  },
})
```

In this project, OAuth is currently built with direct `/auth/v1/authorize` URL and now includes:

`redirect_to=com.nutriscan.app://login-callback`

### 6) Capture the redirect inside app

Use Capacitor `App.addListener('appUrlOpen', ...)` and parse tokens from callback URL.  
This is now implemented in `src/App.jsx`.

---

## B) Fix network/DNS issues for email/password signup

### 1) INTERNET permission

`android.permission.INTERNET` must exist in manifest.  
It is already present in this project.

### 2) Verify Supabase URL + anon key

Use a valid HTTPS Supabase URL and correct anon key.

- URL should look like: `https://YOUR_PROJECT.supabase.co`
- Wrong URL/key often appears as fetch/network failure in app

### 3) Test Supabase URL on phone browser

On the Android device browser, open:

`https://piolbedugsubngftsrkm.supabase.co/auth/v1/health`

Expected: JSON response (or any valid response).  
If unreachable on device, it is network/DNS level, not app code.

### 4) DNS troubleshooting

On device:

- **Settings → Network & Internet → Private DNS**
- Try `dns.google` OR set Private DNS Off (test both)
- Retry signup

### 5) Compare Wi‑Fi vs mobile data

- Test once on Wi‑Fi
- Test once on mobile data
- If mobile data works and Wi‑Fi fails, the Wi‑Fi DNS/firewall is blocking

### 6) Android network security config (only if needed)

Supabase uses HTTPS, so usually no custom config is required.  
Use custom `network_security_config` only when corporate/proxy SSL interception is enforced.

---

## C) Final working code snippets

### 1) Supabase initialization (recommended style)

```ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  'https://piolbedugsubngftsrkm.supabase.co',
  'YOUR_ANON_KEY'
)
```

### 2) Google login function

```ts
const loginWithGoogle = async () => {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: 'com.nutriscan.app://login-callback',
      skipBrowserRedirect: true,
    },
  })
  if (error) throw error
  if (data?.url) {
    // open in browser (Capacitor Browser plugin)
    await Browser.open({ url: data.url })
  }
}
```

### 3) Deep-link handling logic

```ts
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'

CapacitorApp.addListener('appUrlOpen', async ({ url }) => {
  const parsed = new URL(url)
  const hash = new URLSearchParams(parsed.hash.replace('#', ''))
  const accessToken = hash.get('access_token')
  const refreshToken = hash.get('refresh_token')
  if (!accessToken) return

  // Persist session in your storage state
  localStorage.setItem('nutriscan_session', JSON.stringify({
    token: accessToken,
    refresh: refreshToken || '',
  }))

  await Browser.close().catch(() => {})
})
```

---

## D) Run these commands after code/config changes

```powershell
npm install
npx cap sync android
npm run android
```

---

## Quick validation flow (must pass)

1. Open app on Android
2. Tap Google login
3. Complete Google account selection
4. App returns via `com.nutriscan.app://login-callback`
5. User session is created in app
6. Test email signup/login on Wi‑Fi and mobile data
