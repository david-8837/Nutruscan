/**
 * EXAMPLE USAGE: getDayData() Function
 * 
 * This file demonstrates how to integrate getDayData() into Dashboard,
 * Analytics, and History screens for consistent hybrid data fetching.
 */

import { getDayData, getBatchDayData, clearFetchCache } from "./dataFetchers";

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 1: Dashboard Screen (Single Day, Real-time Sync)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dashboard component - fetches data for selected date
 * Renders local data immediately, updates when Supabase sync completes
 */
export function DashboardExample({ selectedDate, user }) {
  const [dayData, setDayData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // Fetch when date changes
  useEffect(() => {
    if (!user?.id || !user?.token) return;

    setIsLoading(true);

    // Call getDayData with callbacks
    getDayData(
      selectedDate,
      user.token,
      user.id,
      supabaseClient, // Your supa object
      {
        // Called immediately with local data
        onLocalReady: (data) => {
          setDayData(data);
          setIsLoading(false);
        },

        // Called when Supabase sync completes and data changed
        onSyncComplete: (updatedData) => {
          setDayData(updatedData);
          setIsSyncing(false);
          toast("Data synced from server ✓", "✅");
        },

        // Called on sync error
        onError: (error) => {
          setIsSyncing(false);
          console.warn("Sync error (keeping local data):", error);
        },
      }
    ).then(() => {
      setIsSyncing(false);
    });

    setIsSyncing(true);
  }, [selectedDate, user?.id, user?.token]);

  if (!dayData) return <div>Loading...</div>;

  return (
    <div className="dashboard">
      {isSyncing && <div className="sync-badge">📡 Syncing...</div>}

      <div className="stats">
        <StatCard label="Calories" value={dayData.calories} unit="kcal" />
        <StatCard label="Protein" value={dayData.protein} unit="g" />
        <StatCard label="Carbs" value={dayData.carbs} unit="g" />
        <StatCard label="Fats" value={dayData.fats} unit="g" />
        <StatCard label="Water" value={dayData.water} unit="cups" />
      </div>

      <MealsList meals={dayData.meals} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 2: Analytics Screen (Multiple Days, Batch Fetch)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analytics component - fetches last 30 days for charts
 * Uses getBatchDayData for efficient batch loading
 */
export function AnalyticsExample({ user }) {
  const [analyticsData, setAnalyticsData] = useState(new Map());
  const [isLoading, setIsLoading] = useState(true);

  // Generate last 30 days
  const generateDateRange = (count = 30) => {
    const dates = [];
    const today = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      dates.push(`${year}-${month}-${day}`);
    }
    return dates;
  };

  useEffect(() => {
    if (!user?.id || !user?.token) return;

    setIsLoading(true);

    // Fetch last 30 days in one batch
    getBatchDayData(
      generateDateRange(30),
      user.token,
      user.id,
      supabaseClient
    ).then((results) => {
      setAnalyticsData(results);
      setIsLoading(false);
    });
  }, [user?.id, user?.token]);

  if (isLoading) return <div>Loading analytics...</div>;

  // Transform for charts
  const chartData = Array.from(analyticsData.entries()).map(([date, data]) => ({
    date,
    calories: data.calories,
    protein: data.protein,
    carbs: data.carbs,
    fats: data.fats,
    water: data.water,
  }));

  return (
    <div className="analytics">
      <CalorieChart data={chartData} />
      <MacroChart data={chartData} />
      <WaterChart data={chartData} />
      <SummaryStats data={analyticsData} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 3: History Screen (Per-Day Expandable List)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * History component - lazy-loads data as user scrolls
 * Uses getBatchDayData with pagination
 */
export function HistoryExample({ user }) {
  const [historyData, setHistoryData] = useState(new Map());
  const [currentPage, setCurrentPage] = useState(0);
  const itemsPerPage = 10;

  // Generate date range for current page
  const generatePageDates = (pageNum, itemsPerPage) => {
    const dates = [];
    const today = new Date();
    const startIdx = pageNum * itemsPerPage;
    for (let i = startIdx + itemsPerPage - 1; i >= startIdx; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      dates.push(`${year}-${month}-${day}`);
    }
    return dates;
  };

  // Load more when user scrolls
  const handleLoadMore = async () => {
    const pageDates = generatePageDates(currentPage, itemsPerPage);

    const newData = await getBatchDayData(
      pageDates,
      user.token,
      user.id,
      supabaseClient
    );

    // Merge with existing data
    setHistoryData((prev) => new Map([...prev, ...newData]));
    setCurrentPage((p) => p + 1);
  };

  const displayedDates = generatePageDates(currentPage, itemsPerPage);

  return (
    <div className="history">
      <h2>History</h2>

      <div className="history-list">
        {displayedDates.map((date) => {
          const dayData = historyData.get(date);
          return (
            <HistoryDayRow
              key={date}
              date={date}
              dayData={dayData}
              isLoading={!dayData}
            />
          );
        })}
      </div>

      <button onClick={handleLoadMore} className="btn-load-more">
        Load More ({currentPage + 1} page)
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 4: Reactive Hook (useGetDayData)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Custom hook for encapsulating getDayData logic
 * Use in any component that needs to fetch a single day
 */
export function useGetDayData(date, user) {
  const [dayData, setDayData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user?.id || !user?.token) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setIsSyncing(true);
    setError(null);

    getDayData(date, user.token, user.id, supabaseClient, {
      onLocalReady: (data) => {
        setDayData(data);
        setIsLoading(false);
      },
      onSyncComplete: (updatedData) => {
        setDayData(updatedData);
        setIsSyncing(false);
      },
      onError: (err) => {
        setError(err);
        setIsSyncing(false);
      },
    });
  }, [date, user?.id, user?.token]);

  return { dayData, isLoading, isSyncing, error };
}

// Usage in component:
function MyComponent({ selectedDate, user }) {
  const { dayData, isLoading, isSyncing } = useGetDayData(selectedDate, user);

  if (isLoading) return <Spinner />;

  return (
    <div>
      {isSyncing && <SyncBadge />}
      <StatCard calories={dayData.calories} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 5: Using with State Management (Reducer Pattern)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reducer for managing analytics screen state
 */
function analyticsReducer(state, action) {
  switch (action.type) {
    case "SET_LOADING":
      return { ...state, isLoading: action.payload };

    case "SET_DATA":
      return {
        ...state,
        data: new Map([...state.data, ...action.payload]),
        isLoading: false,
      };

    case "SET_ERROR":
      return { ...state, error: action.payload, isLoading: false };

    default:
      return state;
  }
}

export function AnalyticsWithReducer({ user }) {
  const [state, dispatch] = useReducer(analyticsReducer, {
    data: new Map(),
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!user?.id || !user?.token) return;

    dispatch({ type: "SET_LOADING", payload: true });

    const dates = generateDateRange(30);

    getBatchDayData(dates, user.token, user.id, supabaseClient)
      .then((results) => {
        dispatch({ type: "SET_DATA", payload: results });
      })
      .catch((err) => {
        dispatch({ type: "SET_ERROR", payload: err });
      });
  }, [user?.id, user?.token]);

  return (
    <div>
      {state.isLoading && <Spinner />}
      {state.error && <ErrorAlert error={state.error} />}
      <ChartGrid data={state.data} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 6: Logout & Cache Cleanup
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Call clearFetchCache() on logout to clean up in-flight requests and cache
 */
export function handleLogout(user) {
  if (user?.token) {
    signOut(user.token).catch(() => {});
  }

  // Clear all cached data
  clearFetchCache();

  // Clear app state
  setUser(null);
  setMeals([]);
  setWater(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// KEY BENEFITS OF THIS APPROACH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 1. LOCAL-FIRST RENDERING
 *    - Data shows instantly from localStorage
 *    - Zero perceived latency for users
 *    - No loading spinners for cached data
 *
 * 2. BACKGROUND SYNC
 *    - Supabase fetch happens without blocking UI
 *    - User can interact while sync happens
 *    - Data updates automatically when sync completes
 *
 * 3. DEDUPLICATION
 *    - normalizeMealList() removes duplicates
 *    - Prevents stale old food items from reappearing
 *
 * 4. SMART CHANGE DETECTION
 *    - dayStateEquals() prevents unnecessary re-renders
 *    - Only updates UI if actual data changed
 *    - Saves bandwidth by not writing unchanged data
 *
 * 5. RACE CONDITION PROTECTION
 *    - Request ID guards prevent stale responses
 *    - If user switches date, old request won't overwrite new data
 *    - Handles rapid date/time switching smoothly
 *
 * 6. OFFLINE SUPPORT
 *    - Works with just localStorage when offline
 *    - No errors or crashes without network
 *    - Transparent fallback to local-only mode
 *
 * 7. REQUEST DEDUPLICATION
 *    - fetchInFlight map prevents duplicate requests
 *    - If two components ask for same date, only one Supabase call
 *    - Reduces server load and bandwidth
 *
 * 8. CACHE WITH TTL
 *    - 5-min cache prevents excessive Supabase queries
 *    - Configurable TTL (CACHE_TTL_MS)
 *    - Balance between freshness and performance
 *
 * 9. CONSISTENT DATA FORMAT
 *    - All screens use same output: { date, calories, protein, carbs, fats, water, meals }
 *    - Easy to integrate into charts, tables, stats
 *    - No format conversion needed per-screen
 *
 * 10. BATCH EFFICIENCY
 *    - getBatchDayData() fetches multiple dates in one query
 *    - Much faster than calling getDayData() in a loop
 *    - Perfect for analytics screens needing 30+ days
 */

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION PATH FROM CURRENT loadUserData()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BEFORE (in App.jsx):
 * 
 * const [meals, setMeals] = useState([]);
 * const [water, setWater] = useState(0);
 * 
 * const loadUserData = async (token, uid, forDate) => {
 *   const localState = loadLocalDay(uid, dateKey);
 *   setMeals(localState.meals);
 *   setWater(localState.water);
 *   // ... then fetch Supabase in background
 * };
 * 
 * // In Dashboard:
 * <Dashboard meals={meals} water={water} />
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * AFTER (using getDayData):
 * 
 * // In Dashboard:
 * function Dashboard({ user, selectedDate }) {
 *   const { dayData, isSyncing } = useGetDayData(selectedDate, user);
 *   
 *   return (
 *     <div>
 *       <Stats calories={dayData.calories} protein={dayData.protein} />
 *       <MealsList meals={dayData.meals} />
 *     </div>
 *   );
 * }
 *
 * Benefits:
 * - No need to manage meals/water state at root
 * - Each component fetches what it needs
 * - Decoupled from App.jsx
 * - Easier to test (just pass date and user)
 * - Can refactor App.jsx without affecting screens
 */
