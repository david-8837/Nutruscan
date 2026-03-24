<!-- Quick Reference Card for Hybrid Data Fetching -->

# 📋 Hybrid Data Fetching — Quick Reference

## Import

```javascript
import { getDayData, getBatchDayData, clearFetchCache } from "./dataFetchers";
```

---

## Function Signatures

### getDayData()
```javascript
const data = await getDayData(
  "2024-03-24",           // date: YYYY-MM-DD
  user.token,             // token: JWT string  
  user.id,                // uid: string
  supabaseClient,         // client: Supabase
  {                       // callbacks: optional
    onLocalReady: d => setData(d),
    onSyncComplete: d => setData(d),
    onError: e => log(e)
  }
);

// Returns: { date, calories, protein, carbs, fats, water, meals[] }
```

### getBatchDayData()
```javascript
const map = await getBatchDayData(
  ["2024-03-24", "2024-03-23"],  // dates: array
  user.token,                     // token: JWT
  user.id,                        // uid: string
  supabaseClient                  // client: Supabase
);

// Returns: Map<dateString => dayData>
```

### clearFetchCache()
```javascript
clearFetchCache();  // Call on logout
```

---

## Data Format

```javascript
{
  date: "2024-03-24",      // YYYY-MM-DD
  calories: 2100,          // integer
  protein: 150,            // grams
  carbs: 200,              // grams
  fats: 70,                // grams
  water: 8,                // glasses
  meals: [                 // array
    {
      id: "uuid",
      name: "Grilled Chicken",
      cal: 350,
      p: 50, c: 0, f: 15,
      e: "🍗",
      m: "Lunch",
      t: "12:30 PM"
    }
  ]
}
```

---

## Quick Patterns

### Pattern 1: Single Day (Dashboard)

```javascript
import { getDayData } from "./dataFetchers";

function Dashboard({ user, selectedDate }) {
  const [data, setData] = useState(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    setSyncing(true);
    getDayData(selectedDate, user.token, user.id, supa, {
      onLocalReady: d => { setData(d); setSyncing(false); },
      onSyncComplete: d => setData(d),
    });
  }, [selectedDate, user?.id]);

  if (!data) return <Loading />;
  return (
    <div>
      {syncing && <span>⟳</span>}
      <Stats cal={data.calories} p={data.protein} />
    </div>
  );
}
```

### Pattern 2: Multiple Days (Analytics)

```javascript
import { getBatchDayData } from "./dataFetchers";

function Analytics({ user }) {
  const [data, setData] = useState(new Map());

  useEffect(() => {
    if (!user?.id) return;
    const dates = generateLast(30);  // Your date generator
    getBatchDayData(dates, user.token, user.id, supa)
      .then(setData);
  }, [user?.id]);

  const chart = Array.from(data).map(([d, x]) => ({
    date: d,
    cal: x.calories
  }));
  
  return <LineChart data={chart} />;
}
```

### Pattern 3: Reusable Hook

```javascript
function useGetDayData(date, user) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id || !date) return;
    getDayData(date, user.token, user.id, supa, {
      onLocalReady: d => { setData(d); setLoading(false); },
      onSyncComplete: setData
    });
  }, [date, user?.id]);

  return { data, loading };
}

// Usage:
function MyComponent({ user, date }) {
  const { data } = useGetDayData(date, user);
  return <Stats data={data} />;
}
```

### Pattern 4: Logout

```javascript
function handleLogout() {
  if (user?.token) supa.signOut(user.token).catch(() => {});
  clearFetchCache();  // Important!
  setUser(null);
  navigate("/login");
}
```

---

## Key Behaviors

| Scenario | Behavior |
|----------|----------|
| **First call, online** | Load local → return instantly → fetch Supabase → update |
| **Offline** | Load local → return instantly → no fetch → done |
| **Rapid date switch** | Discard old sync, apply new one (request ID guard) |
| **Duplicate request** | Skip Supabase, return local (request dedup) |
| **Sync error** | Keep local data, call `onError`, no crash |

---

## Callbacks

### onLocalReady(data)
- **Called:** Immediately after loading localStorage
- **Data:** Local data only (might be empty)
- **Use:** Set initial UI state, stop loading spinner

### onSyncComplete(data)  
- **Called:** After Supabase sync completes AND data changed
- **Data:** Remote data (merged with local)
- **Use:** Update UI with fresh data

### onError(error)
- **Called:** If Supabase fetch fails
- **Data:** Error object
- **Use:** Log error, show warning (optional)

---

## Offline Behavior

```javascript
// Works automatically, no special code needed!

// If offline:
// ✓ Loads from localStorage
// ✓ Returns data immediately
// ✓ Skips Supabase (no error)
// ✓ Calls onLocalReady() with local data

// If online later:
// ✓ Background app refresh triggers sync
// ✓ Supabase data fetched
// ✓ onSyncComplete() called with remote data
```

---

## Debugging

### Check if Syncing

```javascript
function App() {
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    setSyncing(true);
    getDayData(date, token, uid, supa, {
      onLocalReady: () => setSyncing(false),  // Stop immediately
      onSyncComplete: () => {/* still syncing by now */},
    });
  }, [date]);

  return (
    <>
      {syncing && <status>Syncing…</status>}
    </>
  );
}
```

### Console Logging

```javascript
getDayData(date, token, uid, supa, {
  onLocalReady: d => console.log("✓ Local:", d),
  onSyncComplete: d => console.log("✓ Synced:", d),
  onError: e => console.error("✗ Error:", e),
});
```

### Network Tab

DevTools → Network → Filter: `supabase`

- Shows all Supabase calls
- See request body, response, timing
- Verify only one call per date (dedup working)
- Check frequency (cache working = fewer calls)

### Test Offline

```javascript
// DevTools → Network → Throttle → Offline
// Then use app normally
```

---

## Performance Tips

✅ **DO:**
- Use `getBatchDayData()` for multiple dates
- Reuse hooks (same date = one Supabase call)
- Return local data immediately
- Cache for 5+ min (configurable)

❌ **DON'T:**
- Call `getDayData()` in a loop (use batch)
- Await all calls sequentially (use `Promise.all()`)
- Re-fetch same date every render (use `useEffect` with deps)
- Clear cache every minute (kill performance)

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Blank UI** | Check `onLocalReady` is setting data |
| **Stale data** | Check Supabase is updating localStorage |
| **Duplicate meals** | `normalizeMealList()` handles auto |
| **Constant syncing** | Cache TTL too short? Check CACHE_TTL_MS |
| **Offline not working** | Check `localStorage` is available |
| **Rapid date jumps** | Request ID guards handle auto |

---

## File Locations

```
src/
  dataFetchers.js          ← Main module
  dataFetchersExample.js   ← Examples (reference)
  hooks/
    useGetDayData.js       ← Custom hook (create this)
DATA_FETCHING_GUIDE.md     ← Full docs
```

---

## Checklist: First Integration

- [ ] Import `getDayData` in Dashboard
- [ ] Call `getDayData()` in `useEffect`
- [ ] Set state in `onLocalReady` callback
- [ ] Test with console.log
- [ ] Check Network tab for Supabase calls
- [ ] Test offline mode (DevTools)
- [ ] Test date switching (rapid clicks)
- [ ] Deploy and verify

---

## At a Glance

**What it does:**
- Loads nutrition data from localStorage (instant)
- Syncs with Supabase in background (no waiting)
- Works offline (graceful fallback)
- Prevents duplicates (smart dedup)
- Handles race conditions (request IDs)

**When to use:**
- Fetching meal data for a specific date ✓
- Loading analytics for 7-30 days ✓
- History screen pagination ✓

**When NOT to use:**
- User profile data (one-time fetch) ✗
- Settings (different pattern) ✗
- Real-time data (use subscriptions) ✗

---

**TL;DR:** Call `getDayData()` or `getBatchDayData()`, wait for `onLocalReady()`, UI updates instantly. Supabase syncs in background. Done! 🎉
