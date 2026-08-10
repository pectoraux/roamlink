# RoamLink Mobile App

React Native + Expo app — the **primary consumer connectivity experience**.

> **Web discovers and sells connectivity. Mobile installs, manages and uses connectivity.**

## Architecture

The mobile app is a client of the same RoamLink backend as the web app. It does **not** communicate directly with eSIM or payment providers. All sensitive operations go through the backend API.

- **Framework**: React Native + Expo (Expo Router for navigation)
- **Auth**: Session token stored in `expo-secure-store` (not AsyncStorage)
- **API**: Shared `@roamlink/shared` package — same types + API client as web
- **Navigation**: Tab-based (Home, Explore, My eSIMs, Activity, Profile)

## Getting Started

```bash
cd apps/mobile
npm install
npx expo start
```

Set the backend URL:
```bash
# For local dev (use your machine's IP, not localhost — the emulator is a separate VM)
export EXPO_PUBLIC_API_URL=http://192.168.1.x:3000

# For production
export EXPO_PUBLIC_API_URL=https://roamlink-chi.vercel.app
```

## Screens

| Screen | Purpose |
|--------|---------|
| Home | Active eSIM status, quick search, popular destinations |
| Explore | Destination-first browsing, grouped by region |
| My eSIMs | All user eSIMs with status |
| Activity | Order history |
| Profile | Account info, sign out |
| Login | Email/password + demo quick-login |
| Plan `[id]` | Plan detail + buy |
| Checkout `[planId]` | Simple pay (mock) |
| eSIM `[id]` | Usage, QR code, activation, install steps, simulate usage |
| Install `[esimId]` | Post-purchase installation flow |
| Top-up `[esimId]` | Top-up package selection + purchase |

## Cross-Platform Account

The same user account works on web and mobile. Purchase on web → eSIM appears on mobile (and vice versa). One canonical User identity, one shared backend.

## eSIM Installation

The app shows QR code + manual activation details (SM-DP+ address, activation code). Native installation via platform APIs requires native modules — the architecture supports adding an `ESIMInstallationService` with platform-specific implementations, but QR/manual fallback is always available.

**Do NOT assume native installation works on every device.** eSIM hardware compatibility and native installation support are not the same thing.

## Development

The mock eSIM and payment providers work end-to-end. Set `EXIM_PROVIDER=mock` and `PAYMENT_PROVIDER=mock` on the backend.
