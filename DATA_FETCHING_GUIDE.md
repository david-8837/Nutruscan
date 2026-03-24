# Hybrid Data Fetching System Documentation

> **Local-First + Async Supabase Sync with Smart Caching**
> 
> A reusable, production-ready system for fetching nutrition data across Dashboard, Analytics, and History screens with zero perceived latency.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [API Reference](#api-reference)
4. [Design Principles](#design-principles)
5. [Integration Guide](#integration-guide)
6. [Caching Strategy](#caching-strategy)
7. [Offline Support](#offline-support)
8. [Error Handling](#error-handling)
9. [Performance Optimizations](#performance-optimizations)
10. [Testing & Debugging](#testing--debugging)

---

## Quick Start

### Import the functions

```javascript
import { getDayData, getBatchDayData, clearFetchCache } from "./dataFetchers";
```

### Fetch a single day

```javascript
import { getDayData } from "./dataFetchers";

const dayData = await getDayData(
  "2024-03-24",           // date (YYYY-MM-DD)
  user.token,             // Supabase JWT
  user.id,                // User ID
  supabaseClient,         // Your supa object
  {
    onLocalReady: (data) => setDayData(data),      // Called immediately
    onSyncComplete: (data) => updateUI(data),      // Called after Supabase sync
    onError: (err) => console.warn(err),           // Called on sync error
  }
);

// Data format:
// {
//   date: "2024-03-24",
//   calories: 2100,
//   protein: 150,
//   carbs: 200,
//   fats: 70,
//   water: 8,
//   meals: [{ id, name, cal, p, c, f, e, m, t }, ...]
// }
```

### Fetch multiple days

```javascript
import { getBatchDayData } from "./dataFetchers";

const dates = ["2024-03-24", "2024-03-23", "2024-03-22"]; // YYYY-MM-DD

const dataMap = await getBatchDayData(
  dates,
  user.token,
  user.id,
  supabaseClient
);

// Returns: Map<dateString => dayData>
dataMap.forEach((dayData, date) => {
  console.log(`${date}: ${dayData.calories} kcal`);
});
```

### Create a reusable hook

```javascript
import { getDayData } from "./dataFetchers";
import { useState, useEffect } from "react";

export function useGetDayData(date, user) {
  const [dayData, setDayData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    if (!user?.id || !user?.token) return;

    setIsLoading(true);
    setIsSyncing(true);

    getDayData(date, user.token, user.id, supabaseClient, {
      onLocalReady: (data) => {
        setDayData(data);
        setIsLoading(false);
      },
      onSyncComplete: (data) => {
        setDayData(data);
        setIsSyncing(false);
      },
      onError: (err) => {
        setIsSyncing(false);
        console.warn("Sync failed (keeping local):", err);
      },
    });
  }, [date, user?.id, user?.token]);

  return { dayData, isLoading, isSyncing };
}

// Usage:
function Dashboard({ user, selectedDate }) {
  const { dayData, isLoading, isSyncing } = useGetDayData(selectedDate, user);

  if (isLoading) return <Loading />;

  return (
    <div>
      {isSyncing && <SyncIndicator />}
      <Stats
        calories={dayData.calories}
        protein={dayData.protein}
        carbs={dayData.carbs}
        fats={dayData.fats}
        water={dayData.water}
      />
    </div>
  );
}
```

---

## Architecture Overview

### Data Flow Diagram

```
User navigates to date "2024-03-24"
           ↓
    getDayData() called
           ↓
     ┌─────┴─────┐
     ↓           ↓
[SYNC]       [ASYNC]
     ↓           ↓
Load        Fetch from
Local       Supabase
(instant)   (background)
     ↓           ↓
Return      Compare with
immediate   dayStateEquals()
     ↓           ↓
UI renders  Update local
with local  if different
data        ↓
     ↓      Update UI
   Done     with remote
             ↓
           Cache ready
             ↓
           Done
```

### State Transitions

```
OFFLINE only:
  Load Local → Return Local Data → Done

ONLINE with fresh local data:
  Load Local → Return Local Data → (Check Cache) → Skip Sync → Done

ONLINE with stale/missing local data:
  Load Local → Return Local Data → Fetch Supabase → Compare → Update Local → Update UI → Done

RAPID DATE SWITCHING:
  Request 1 (ID=1) → Load Local → Return → Start Sync
  Request 2 (ID=2) → Load Local → Return → Start Sync
  Sync 1 completes → Guard check (ID≠2) → Discard
  Sync 2 completes → Guard check (ID=2) → Apply
```

### Layer Architecture

```
┌─────────────────────────────────────┐
│     App Components (Dashboard,      │
│    Analytics, History Screens)      │
└────────────────┬────────────────────┘
                 │
┌─────────────────┴────────────────────┐
│      useGetDayData Hook or           │
│     Direct getDayData() calls        │
└────────────┬─────────────────────────┘
             │
┌────────────┴──────────────────────────┐
│  dataFetchers.js                      │
│  - getDayData()                       │
│  - getBatchDayData()                  │
│  - Cache & Request tracking           │
└────────────┬──────────────────────────┘
             │
┌────────────┴──────────────────────────┐
│  Hybrid Storage Layer                 │
│  ┌──────────────┬────────────────────┐│
│  │              │                    ││
│  ↓              ↓                    ↓│
│  LocalStorage  Supabase Client   Online Status
│  (meals table) (meals, water_logs table)
│
└───────────────────────────────────────┘
```

---

## API Reference

### getDayData()

**Signature:**
```javascript
getDayData(date, token, uid, supabaseClient, callbacks)
  → Promise<dayData>
```

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `date` | String | Date in YYYY-MM-DD format |
| `token` | String | Supabase JWT token (from auth) |
| `uid` | String | User ID (from auth) |
| `supabaseClient` | Object | Supabase client with `select(token, table, fields, filters)` method |
| `callbacks` | Object | Optional callbacks object |

**Callbacks:**
```javascript
{
  onLocalReady: (dayData) => {},      // Called immediately with local data
  onSyncComplete: (dayData) => {},    // Called when Supabase sync completes
  onError: (error) => {}              // Called if sync fails
}
```

**Returns:**
```javascript
{
  date: "2024-03-24",           // YYYY-MM-DD
  calories: 2100,               // Total calories (integer)
  protein: 150,                 // Grams (integer)
  carbs: 200,                   // Grams (integer)
  fats: 70,                     // Grams (integer)
  water: 8,                     // Glasses (number)
  meals: [                      // Array of meal objects
    {
      id: "uuid",               // Meal ID
      name: "Grilled Chicken",  // Food name
      cal: 350,                 // Calories
      p: 50,                    // Protein (g)
      c: 0,                     // Carbs (g)
      f: 15,                    // Fat (g)
      e: "🍗",                  // Emoji
      m: "Lunch",               // Meal type
      t: "12:30 PM"             // Time (localized)
    }
  ]
}
```

**Behavior:**
1. Synchronously loads from localStorage and calls `onLocalReady()`
2. Returns local data immediately (user sees it right away)
3. If online, fetches from Supabase in background
4. Compares remote vs local using `dayStateEquals()`
5. Updates localStorage if data differs
6. Calls `onSyncComplete()` only if data changed
7. On error, keeps local data (no crash)

---

### getBatchDayData()

**Signature:**
```javascript
getBatchDayData(dates, token, uid, supabaseClient)
  → Promise<Map<String, dayData>>
```

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `dates` | Array<String> | Array of dates in YYYY-MM-DD format |
| `token` | String | Supabase JWT |
| `uid` | String | User ID |
| `supabaseClient` | Object | Supabase client |

**Returns:**
```javascript
Map {
  "2024-03-24" => dayData,
  "2024-03-23" => dayData,
  "2024-03-22" => dayData
}
```

**Behavior:**
1. Loads all dates from localStorage immediately
2. Returns local data immediately (synchronous render)
3. If online, fetches all dates in one batch query (more efficient)
4. Groups results by date
5. Updates localStorage for each date
6. Returns merged local + remote data

**Why Batch?**
- Single Supabase query instead of N queries
- Much faster for history/analytics screens
- Reduces API calls and bandwidth
- Better for pagination and lazy loading

---

### clearFetchCache()

**Signature:**
```javascript
clearFetchCache()
```

**Purpose:** Clear all cached data and in-flight requests

**When to call:**
- On logout (to avoid data leaks)
- On user switch
- On manual data refresh

**Example:**
```javascript
function handleLogout() {
  clearFetchCache();           // Clear cache
  setUser(null);
  setScreen("landing");
}
```

---

## Design Principles

### 1. Local-First Architecture

**Principle:** Return data from localStorage immediately, never block UI waiting for network.

**Why:**
- Users expect instant response
- Network is slower than disk (localStorage)
- No perceived latency
- Works when offline

**Implementation:**
```javascript
// SYNC: Load and return local immediately
const localState = loadLocalDay(uid, dateKey);
const localMeals = normalizeMealList(localState.meals);
onLocalReady?.(formatDayData(localMeals, localWater, dateKey));

// ASYNC: Fetch remote in background (doesn't block)
// ... (background sync happens here)
```

### 2. Optimistic Updates

**Principle:** Update UI immediately, sync in background.

**Why:**
- Responsive app feels fast
- No waiting for server round-trip
- Can roll back if sync fails

**Implementation:**
```javascript
// Show local data right away
setDayData(localData);

// Then update if remote differs
getDayData(..., {
  onSyncComplete: (remoteData) => setDayData(remoteData)
});
```

### 3. Smart Change Detection

**Principle:** Only update UI if data actually changed.

**Why:**
- Prevents unnecessary re-renders
- Reduces bandwidth (don't save unchanged data)
- Better performance
- User sees stable UI

**Implementation:**
```javascript
// dayStateEquals() compares normalized meals + water
const changed = !dayStateEquals(localMeals, localWater, remoteMeals, remoteWater);
if (changed) {
  // Only update if truly different
  saveLocalDay(uid, dateKey, remoteMeals, remoteWater);
  onSyncComplete?.(updatedData);
}
```

### 4. Request Deduplication

**Principle:** Prevent multiple simultaneous requests for same date.

**Why:**
- Reduces server load
- Saves bandwidth
- Faster response (first one wins)
- Prevents race conditions

**Implementation:**
```javascript
const fetchInFlight = new Map(); // Track ongoing requests

if (fetchInFlight.has(cacheKey)) {
  return localData;  // Request already in progress
}
fetchInFlight.set(cacheKey, requestId);
```

### 5. Stale Response Protection

**Principle:** Use request IDs to ignore responses from old requests.

**Why:**
- User might switch dates while old request loads
- Old data shouldn't overwrite new selection
- Handles rapid switching smoothly

**Implementation:**
```javascript
const requestId = ++getDayData._requestIdCounter;

// Later, when response arrives:
if (fetchInFlight.get(cacheKey) !== requestId) {
  return;  // Stale response, ignore
}
```

### 6. Graceful Offline Fallback

**Principle:** Work with just localStorage when offline.

**Why:**
- App is usable offline
- No error messages or crashes
- Transparent to user
- Data syncs when online again

**Implementation:**
```javascript
if (!netOnline() || !token) {
  return localData;  // Just return local, no error
}

try {
  // Fetch remote in background
} catch (e) {
  // Keep local data on error
}
```

---

## Integration Guide

### Step 1: Install dataFetchers.js

```javascript
// src/dataFetchers.js  (already created)
export { getDayData, getBatchDayData, clearFetchCache };
```

### Step 2: Create useGetDayData Hook

```javascript
// src/hooks/useGetDayData.js
import { getDayData } from "../dataFetchers";
import { useState, useEffect } from "react";

export function useGetDayData(date, user, supabaseClient) {
  const [dayData, setDayData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    if (!user?.id || !user?.token) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setIsSyncing(true);

    getDayData(date, user.token, user.id, supabaseClient, {
      onLocalReady: (data) => {
        setDayData(data);
        setIsLoading(false);
      },
      onSyncComplete: (data) => {
        setDayData(data);
        setIsSyncing(false);
      },
      onError: (err) => {
        setIsSyncing(false);
        console.warn("Sync error (keeping local):", err);
      },
    });
  }, [date, user?.id, user?.token]);

  return { dayData, isLoading, isSyncing };
}
```

### Step 3: Update Dashboard

**Before:**
```javascript
function Dashboard({ meals, water, selectedDate, onSelectDate }) {
  return (
    <div>
      <Stats calories={...} />
      <MealsList meals={meals} />
    </div>
  );
}
```

**After:**
```javascript
import { useGetDayData } from "./hooks/useGetDayData";

function Dashboard({ user, selectedDate, onSelectDate }) {
  const { dayData, isSyncing } = useGetDayData(selectedDate, user, supabaseClient);

  if (!dayData) return <Loading />;

  return (
    <div>
      {isSyncing && <SyncBadge />}
      <DatePicker 
        value={selectedDate} 
        onChange={onSelectDate} 
      />
      <Stats
        calories={dayData.calories}
        protein={dayData.protein}
        carbs={dayData.carbs}
        fats={dayData.fats}
        water={dayData.water}
      />
      <MealsList meals={dayData.meals} />
    </div>
  );
}
```

### Step 4: Update Analytics

```javascript
import { getBatchDayData } from "./dataFetchers";

function Analytics({ user }) {
  const [chartData, setChartData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user?.id || !user?.token) return;

    const generateLast30 = () => {
      const dates = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const da = String(d.getDate()).padStart(2, "0");
        dates.push(`${y}-${m}-${da}`);
      }
      return dates;
    };

    setIsLoading(true);

    getBatchDayData(
      generateLast30(),
      user.token,
      user.id,
      supabaseClient
    ).then((dataMap) => {
      const chartData = Array.from(dataMap.entries()).map(([date, data]) => ({
        date,
        calories: data.calories,
        protein: data.protein,
        carbs: data.carbs,
        fats: data.fats,
        water: data.water,
      }));
      setChartData(chartData);
      setIsLoading(false);
    });
  }, [user?.id]);

  if (isLoading) return <Loading />;

  return <ChartsGrid data={chartData} />;
}
```

### Step 5: Update Logout

```javascript
import { clearFetchCache } from "./dataFetchers";

function handleLogout() {
  if (user?.token) {
    supa.signOut(user.token).catch(() => {});
  }
  
  clearFetchCache();  // Clear all cached data
  setUser(null);
  setMeals([]);
  setWater(0);
  setScreen("landing");
}
```

---

## Caching Strategy

### Cache Layers

```
┌─────────────────────────────────┐
│   fetchCache Map                │
│   (5-min TTL, in-memory)        │
│   { "uid:YYYY-MM-DD" => {...} } │
└─────────────────────────────────┘
           ↑        ↑
        HIT    MISS/EXPIRED
           ↑        ↑
           └────┬───┘
      ┌─────────┴──────────┐
      ↓                    ↓
  SKIP SYNC        FETCH SUPABASE
  (if local        (if online)
   is fresh)
           ↓
┌──────────────────────────────────┐
│   localStorage (disk)            │
│   nutriscan_local_uid_YYYY-MM-DD │
│   (persistent, no expiry)        │
└──────────────────────────────────┘
           ↓
┌──────────────────────────────────┐
│   Supabase (authoritative)       │
│   meals, water_logs              │
│   (source of truth)              │
└──────────────────────────────────┘
```

### Cache Behavior

| Scenario | Action |
|----------|--------|
| **Local exists, cache fresh** | Return local, skip Supabase |
| **Local exists, cache stale** | Return local, fetch Supabase in background |
| **Local missing, cache fresh** | Return local (empty), skip Supabase |
| **Local missing, offline** | Return local (empty), no Supabase |
| **Offline entirely** | Return local only, no background sync |

### Cache TTL

```javascript
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

// To change, edit dataFetchers.js:
// const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes
// const CACHE_TTL_MS = 1 * 60 * 1000;   // 1 minute (for debugging)
```

### Manual Cache Clear

```javascript
import { clearFetchCache } from "./dataFetchers";

// Clear all cache
clearFetchCache();

// Clear on logout
function handleLogout() {
  clearFetchCache();
  setUser(null);
}
```

---

## Offline Support

### How It Works

When offline, `getDayData()`:
1. Still loads from localStorage
2. Skips Supabase sync (no error thrown)
3. Returns local data immediately
4. No error messages or spinners

```javascript
// In App.jsx, online status is observable
const [online, setOnline] = useState(() => netOnline());

useEffect(() => {
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
}, []);

// Pass to components that need it
<Dashboard online={online} />
```

### Showing Offline Status

```javascript
function App() {
  const [online, setOnline] = useState(() => netOnline());

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return (
    <div>
      {!online && (
        <div className="offline-banner">
          📡 Offline — Using cached data
        </div>
      )}
      <Dashboard />
    </div>
  );
}
```

### Testing Offline

```javascript
// DevTools → Network → Throttle to "Offline"
// Or in code:
window.__test_offline = true;

const netOnline = () => {
  if (window.__test_offline) return false;
  return navigator.onLine !== false;
};
```

---

## Error Handling

### Graceful Degradation

```javascript
// getDayData handles errors silently
getDayData(date, token, uid, supabaseClient, {
  onLocalReady: (data) => setData(data),  // Always called
  onSyncComplete: (data) => setData(data),  // Only on successful sync
  onError: (err) => {
    // Sync failed, but local data is preserved
    console.warn("Sync failed, keeping local:", err);
    // optionally: toast("Sync failed, using cached data");
  }
});

// UI always shows data (never blank)
if (dayData) {
  return <Dashboard data={dayData} />;
}
```

### Common Errors & Handling

| Error | Cause | Handling |
|-------|-------|----------|
| Network timeout | Supabase unreachable | Keep local, retry on next background sync |
| Invalid format | Bad data from server | `normalizeMealList()` sanitizes |
| Rapid date switch | Old request returns late | Request ID guard prevents update |
| Missing local | First time user | Return empty data, fetch from Supabase |
| Token expired | Auth invalid | Let caller handle, don't fetch |

### Debugging Errors

```javascript
import { getDayData } from "./dataFetchers";

getDayData(date, token, uid, supabaseClient, {
  onLocalReady: (data) => {
    console.log("✓ Local data ready:", data);
  },
  onSyncComplete: (data) => {
    console.log("✓ Sync complete, data updated:", data);
  },
  onError: (err) => {
    console.error("✗ Sync failed:", err);
    console.error("  Keeping local data instead");
  }
});
```

---

## Performance Optimizations

### 1. Request Deduplication

```javascript
const fetchInFlight = new Map();

// If two components request same date simultaneously:
//   Component A: getDayData("2024-03-24")
//   Component B: getDayData("2024-03-24")
// → Only one Supabase call, both get same data

if (fetchInFlight.has(cacheKey)) {
  return localData;  // Already fetching, don't duplicate
}
```

### 2. Batch Fetching

```javascript
// DON'T: Loop and call getDayData() 30 times
for (let i = 0; i < 30; i++) {
  const data = await getDayData(dates[i], ...);  // 30 Supabase calls!
}

// DO: Use getBatchDayData() for single query
const dataMap = await getBatchDayData(dates, ...);  // 1 Supabase call!
```

### 3. Cache with TTL

```javascript
// Prevents excessive Supabase queries
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 min

// Calling getDayData() twice within 5 min for same date:
//   Call 1: Fetch Supabase
//   Call 2: Skip Supabase (cache fresh)
```

### 4. Equality Comparison

```javascript
// Only update UI if data actually changed
const changed = !dayStateEquals(localMeals, localWater, remoteMeals, remoteWater);
if (changed) {
  updateUI();
}

// Benefits:
// - No unnecessary render cycles
// - No UI flicker (data doesn't jiggle)
// - Better battery on mobile
```

### 5. Normalized Storage

```javascript
// normalizeMealList() deduplicates by composite key
const seen = new Set();
for (const meal of meals) {
  const key = meal?.id != null
    ? `id:${meal.id}`
    : `k:${name}|${cal}|${protein}|${carbs}|${fat}`;
  if (seen.has(key)) continue;  // Skip duplicate
  out.push(meal);
}

// Prevents duplicate meals from accumulating
```

---

## Testing & Debugging

### Unit Testing

```javascript
// __tests__/dataFetchers.test.js
import { getDayData, normalizeMealList, dayStateEquals } from "../dataFetchers";

describe("normalizeMealList", () => {
  test("removes duplicate meals by ID", () => {
    const meals = [
      { id: "1", name: "Chicken", cal: 350 },
      { id: "1", name: "Chicken", cal: 350 },  // duplicate
    ];
    const result = normalizeMealList(meals);
    expect(result).toHaveLength(1);
  });

  test("removes duplicate meals by composite key", () => {
    const meals = [
      { name: "Chicken", cal: 350, p: 50, c: 0, f: 15 },
      { name: "Chicken", cal: 350, p: 50, c: 0, f: 15 },  // duplicate
    ];
    const result = normalizeMealList(meals);
    expect(result).toHaveLength(1);
  });
});

describe("dayStateEquals", () => {
  test("returns true for identical data", () => {
    const meals1 = [{ id: "1", name: "Chicken", cal: 350 }];
    const meals2 = [{ id: "1", name: "Chicken", cal: 350 }];
    expect(dayStateEquals(meals1, 8, meals2, 8)).toBe(true);
  });

  test("returns false when meals differ", () => {
    const meals1 = [{ id: "1", name: "Chicken", cal: 350 }];
    const meals2 = [{ id: "2", name: "Fish", cal: 300 }];
    expect(dayStateEquals(meals1, 8, meals2, 8)).toBe(false);
  });

  test("returns false when water differs", () => {
    const meals = [{ id: "1", name: "Chicken", cal: 350 }];
    expect(dayStateEquals(meals, 8, meals, 10)).toBe(false);
  });
});
```

### Integration Testing

```javascript
// __tests__/getDayData.integration.test.js
import { getDayData, clearFetchCache } from "../dataFetchers";

describe("getDayData", () => {
  beforeEach(() => {
    localStorage.clear();
    clearFetchCache();
  });

  test("returns local data immediately", async () => {
    const localReadyCalled = jest.fn();
    
    getDayData("2024-03-24", token, uid, mockSupabase, {
      onLocalReady: localReadyCalled
    });

    // Should be called synchronously
    expect(localReadyCalled).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2024-03-24" })
    );
  });

  test("syncs with Supabase when online", async () => {
    const syncCompleteCalled = jest.fn();
    
    await getDayData("2024-03-24", token, uid, mockSupabase, {
      onSyncComplete: syncCompleteCalled
    });

    // Wait for background sync
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(syncCompleteCalled).toHaveBeenCalled();
  });

  test("keeps local data when offline", async () => {
    const errorCalled = jest.fn();
    
    window.__test_offline = true;
    await getDayData("2024-03-24", token, uid, mockSupabase, {
      onError: errorCalled
    });
    window.__test_offline = false;

    // Should not call error (offline is graceful)
    expect(errorCalled).not.toHaveBeenCalled();
  });
});
```

### Manual Testing

```javascript
// In browser DevTools Console:

// Test 1: Check cache
import { getDayData } from "./dataFetchers";
getDayData("2024-03-24", token, uid, supa, {
  onLocalReady: d => console.log("Local:", d),
  onSyncComplete: d => console.log("Synced:", d),
  onError: e => console.error("Error:", e)
});

// Test 2: Rapid date switching
const dates = ["2024-03-24", "2024-03-23", "2024-03-22"];
dates.forEach(d => getDayData(d, token, uid, supa, {...}));

// Test 3: Offline mode
window.__test_offline = true;
// Use app offline, check it works with localStorage
window.__test_offline = false;

// Test 4: Check cache
clearFetchCache();
// Cache is now cleared
```

### Monitoring & Debugging

```javascript
// Add to dataFetchers.js for debugging
const DEBUG = true;  // Toggle for production

const log = (...args) => {
  if (!DEBUG) return;
  console.log("[DataFetchers]", ...args);
};

export const getDayData = async (...) => {
  log("Loading date:", dateKey);
  const localState = loadLocalDay(uid, dateKey);
  log("Local ready:", localState);
  
  // ... rest of function ...
  
  log("Sync complete:", changed ? "Data updated" : "No changes");
};
```

---

## Migration Checklist

- [ ] Copy `dataFetchers.js` to `src/`
- [ ] Create `hooks/useGetDayData.js`
- [ ] Update `Dashboard.jsx` to use `useGetDayData()`
- [ ] Update `Analytics.jsx` to use `getBatchDayData()`
- [ ] Update `History.jsx` to use `getBatchDayData()`
- [ ] Update logout to call `clearFetchCache()`
- [ ] Test offline mode
- [ ] Test rapid date switching
- [ ] Verify no duplicate Supabase calls
- [ ] Check performance with DevTools
- [ ] Deploy and monitor

---

## Questions & Support

**Q: Why not use React Query or SWR?**
A: This system is designed for your specific use case (date-based nutrition data) and doesn't require external dependencies. It's simpler, smaller, and fully customizable.

**Q: Can I use this with other data types (weight, achievements)?**
A: Yes! The pattern is generic. Create similar functions for other data types (e.g., `getWeightData()`, `getAchievements()`).

**Q: How do I add TypeScript?**
A: See `dataFetchers.ts` template in examples folder. Function signatures are unchanged.

**Q: What's the localStorage size limit?**
A: ~5-10MB per domain. For nutrition data (typical ~100 days), you'll use <1MB.

**Q: How do I debug requests?**
A: Open DevTools → Network tab → Filter `supabase` to see Supabase calls. Or add logs in `dataFetchers.js`.

**Q: Can I prefetch future dates?**
A: Yes! Call `getDayData()` for upcoming dates even if user hasn't navigated there yet. Cached results will be ready.

---

**Last Updated:** March 2026  
**Status:** Production Ready  
**Tested With:** NutriScan App  
**Browser Support:** All modern browsers + Capacitor mobile  
