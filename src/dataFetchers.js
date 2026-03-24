/**
 * Hybrid Data Fetching System
 * Local-first + async Supabase sync with smart caching
 * 
 * Usage:
 * - Use getDayData(date, token, uid) to fetch meals + water for a specific date
 * - Returns immediately with local data, syncs in background
 * - Handles offline gracefully (returns local-only)
 * - Prevents duplicate fetches with request ID guards
 */

// ═══════════════════════════════════════════════════════════════════════════
// CACHE SYSTEM & REQUEST TRACKING
// ═══════════════════════════════════════════════════════════════════════════

const fetchInFlight = new Map(); // Track ongoing requests to prevent duplicates
const fetchCache = new Map();     // Cache successful fetches with timestamp

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache (bypass if local is fresher)

const isCacheFresh = (timestamp) => {
  if (!timestamp) return false;
  return Date.now() - timestamp < CACHE_TTL_MS;
};

const getCacheKey = (userId, dateStr) => `${userId}:${dateStr}`;

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE HELPERS (mirror from App.jsx)
// ═══════════════════════════════════════════════════════════════════════════

const localDayKey = (uid, day, k) => `nutriscan_local_${uid}_${day}_${k}`;

const loadLocalDay = (uid, day) => {
  try {
    if (!uid || !day) return { meals: null, water: null };
    const m = localStorage.getItem(localDayKey(uid, day, "meals"));
    const w = localStorage.getItem(localDayKey(uid, day, "water"));
    return { meals: m ? JSON.parse(m) : null, water: w != null ? +w : null };
  } catch (e) {
    return { meals: null, water: null };
  }
};

const saveLocalDay = (uid, day, mealsArr, waterVal) => {
  try {
    localStorage.setItem(localDayKey(uid, day, "meals"), JSON.stringify(mealsArr));
    localStorage.setItem(localDayKey(uid, day, "water"), String(waterVal ?? 0));
  } catch (e) {}
};

// ═══════════════════════════════════════════════════════════════════════════
// DATA NORMALIZATION & COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

const normalizeMealList = (mealsArr = []) => {
  const seen = new Set();
  const out = [];
  for (const meal of Array.isArray(mealsArr) ? mealsArr : []) {
    const key =
      meal?.id != null
        ? `id:${meal.id}`
        : `k:${String(meal?.name || "")
            .trim()
            .toLowerCase()}|${Number(meal?.cal || 0)}|${Number(meal?.p || 0)}|${Number(meal?.c || 0)}|${Number(meal?.f || 0)}|${String(meal?.m || "")
            .trim()
            .toLowerCase()}|${String(meal?.t || "").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(meal);
  }
  return out;
};

const dayStateEquals = (aMeals, aWater, bMeals, bWater) => {
  const am = normalizeMealList(aMeals || []);
  const bm = normalizeMealList(bMeals || []);
  if (am.length !== bm.length) return false;
  for (let i = 0; i < am.length; i++) {
    const a = am[i] || {};
    const b = bm[i] || {};
    if (String(a.id || "") !== String(b.id || "")) return false;
    if (String(a.name || "") !== String(b.name || "")) return false;
    if (Number(a.cal || 0) !== Number(b.cal || 0)) return false;
    if (Number(a.p || 0) !== Number(b.p || 0)) return false;
    if (Number(a.c || 0) !== Number(b.c || 0)) return false;
    if (Number(a.f || 0) !== Number(b.f || 0)) return false;
    if (String(a.e || "") !== String(b.e || "")) return false;
    if (String(a.m || "") !== String(b.m || "")) return false;
    if (String(a.t || "") !== String(a.t || "")) return false;
  }
  return Number(aWater || 0) === Number(bWater || 0);
};

// ═══════════════════════════════════════════════════════════════════════════
// DATA FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format day data into standardized output
 * @param {Array} meals - Normalized meal array
 * @param {Number} water - Water intake (glasses)
 * @param {String} date - YYYY-MM-DD string
 * @returns {Object} { date, calories, protein, carbs, fats, water }
 */
const formatDayData = (meals = [], water = 0, date = "") => {
  const calories = meals.reduce((sum, m) => sum + (Number(m.cal) || 0), 0);
  const protein = meals.reduce((sum, m) => sum + (Number(m.p) || 0), 0);
  const carbs = meals.reduce((sum, m) => sum + (Number(m.c) || 0), 0);
  const fats = meals.reduce((sum, m) => sum + (Number(m.f) || 0), 0);

  return {
    date: String(date).slice(0, 10) || "",
    calories: Math.round(calories),
    protein: Math.round(protein),
    carbs: Math.round(carbs),
    fats: Math.round(fats),
    water: Number(water) || 0,
    meals: meals,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// ONLINE STATUS CHECK
// ═══════════════════════════════════════════════════════════════════════════

const netOnline = () => {
  if (typeof navigator === "undefined") return false;
  return navigator.onLine !== false;
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN FETCH FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch day data using hybrid local-first + Supabase background sync
 * 
 * @param {String} date - Date in YYYY-MM-DD format
 * @param {String} token - Supabase JWT token
 * @param {String} uid - User ID
 * @param {Object} supabaseClient - Supabase client with select() and upsert() methods
 * @param {Object} callbacks - Optional { onLocalReady, onSyncComplete, onError }
 * 
 * @returns {Promise<Object>} { date, calories, protein, carbs, fats, water, meals }
 * 
 * Flow:
 * 1. Load local immediately → call onLocalReady, return local data
 * 2. If online, fetch Supabase in background → compare, update local if different
 * 3. On sync complete, call onSyncComplete if data was updated
 * 4. If error, call onError and keep local data
 */
export const getDayData = async (date, token, uid, supabaseClient, callbacks = {}) => {
  const { onLocalReady, onSyncComplete, onError } = callbacks;
  const dateKey = String(date || "").slice(0, 10);
  const cacheKey = getCacheKey(uid, dateKey);

  if (!uid || !dateKey) {
    const emptyData = formatDayData([], 0, dateKey);
    onLocalReady?.(emptyData);
    return emptyData;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: Immediate Local Load (synchronous, non-blocking)
  // ─────────────────────────────────────────────────────────────────────────

  const localState = loadLocalDay(uid, dateKey);
  const localMeals = normalizeMealList(
    Array.isArray(localState.meals) ? localState.meals : []
  );
  const localWater = Number.isFinite(+localState.water) ? +localState.water : 0;
  const localData = formatDayData(localMeals, localWater, dateKey);

  // Return local data immediately (user sees it right away)
  onLocalReady?.(localData);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: Background Supabase Sync (only if online)
  // ─────────────────────────────────────────────────────────────────────────

  if (!netOnline() || !token || !supabaseClient) {
    // Offline or no auth → return local only
    return localData;
  }

  // Prevent duplicate in-flight requests for same date
  if (fetchInFlight.has(cacheKey)) {
    // Request already in progress, don't fetch again
    return localData;
  }

  // Check if we have fresh cached data
  const cached = fetchCache.get(cacheKey);
  if (cached && isCacheFresh(cached.timestamp)) {
    return localData; // Skip sync if cache is fresh
  }

  const requestId = ++getDayData._requestIdCounter;
  fetchInFlight.set(cacheKey, requestId);

  // Background sync (don't await in main function)
  (async () => {
    try {
      // Fetch meals for date
      const mealsResp = await supabaseClient.select(
        token,
        "meals",
        "*",
        `&user_id=eq.${uid}&log_date=eq.${dateKey}&order=logged_at.asc`
      );

      const remoteMealsRaw =
        Array.isArray(mealsResp) && mealsResp.length > 0
          ? mealsResp.map((x) => ({
              id: x.id,
              name: x.name,
              cal: x.calories,
              p: x.protein,
              c: x.carbs,
              f: x.fat,
              e: x.emoji,
              m: x.meal_type,
              t: new Date(x.logged_at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
            }))
          : [];

      const remoteMeals = normalizeMealList(remoteMealsRaw);

      // Fetch water for date
      const waterResp = await supabaseClient.select(
        token,
        "water_logs",
        "glasses",
        `&user_id=eq.${uid}&log_date=eq.${dateKey}`
      );

      const remoteWater = Array.isArray(waterResp) && waterResp[0] ? +waterResp[0].glasses : 0;

      // Guard against stale responses
      if (fetchInFlight.get(cacheKey) !== requestId) {
        return;
      }

      // Compare local vs remote
      const changed = !dayStateEquals(localMeals, localWater, remoteMeals, remoteWater);

      if (changed) {
        // Update local storage with remote data
        saveLocalDay(uid, dateKey, remoteMeals, remoteWater);

        // Notify caller of sync completion with updated data
        const updatedData = formatDayData(remoteMeals, remoteWater, dateKey);
        onSyncComplete?.(updatedData);
      } else {
        // Data unchanged, just update cache timestamp
        fetchCache.set(cacheKey, { timestamp: Date.now() });
      }
    } catch (error) {
      // Network error or Supabase error
      onError?.(error);
      // Keep local data; don't break UI on sync failure
    } finally {
      // Remove from in-flight tracking
      if (fetchInFlight.get(cacheKey) === requestId) {
        fetchInFlight.delete(cacheKey);
      }
    }
  })();

  return localData;
};

// Request ID counter for stale-response prevention
getDayData._requestIdCounter = 0;

// ═══════════════════════════════════════════════════════════════════════════
// BATCH FETCH (for analytics/history screens)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch multiple days of data with efficient batching
 * 
 * @param {Array<String>} dates - Array of dates in YYYY-MM-DD format
 * @param {String} token - Supabase JWT
 * @param {String} uid - User ID
 * @param {Object} supabaseClient - Supabase client
 * 
 * @returns {Promise<Map<String, Object>>} Map of date => day data
 */
export const getBatchDayData = async (dates, token, uid, supabaseClient) => {
  const results = new Map();

  // Load all from local immediately
  for (const date of dates) {
    const localState = loadLocalDay(uid, date);
    const localMeals = normalizeMealList(
      Array.isArray(localState.meals) ? localState.meals : []
    );
    const localWater = Number.isFinite(+localState.water) ? +localState.water : 0;
    results.set(date, formatDayData(localMeals, localWater, date));
  }

  // Background sync for all dates
  if (!netOnline() || !token || !supabaseClient) {
    return results;
  }

  // Batch fetch from Supabase (more efficient than looping getDayData)
  const dateRange = `&log_date=gte.${dates[dates.length - 1]}&log_date=lte.${dates[0]}`;

  try {
    const mealsResp = await supabaseClient.select(
      token,
      "meals",
      "*",
      `&user_id=eq.${uid}${dateRange}&order=log_date.asc,logged_at.asc`
    );

    const waterResp = await supabaseClient.select(
      token,
      "water_logs",
      "*",
      `&user_id=eq.${uid}${dateRange}&order=log_date.asc`
    );

    // Group by date
    const mealsByDate = new Map();
    const waterByDate = new Map();

    if (Array.isArray(mealsResp)) {
      for (const meal of mealsResp) {
        const date = String(meal.log_date || "").slice(0, 10);
        if (!date) continue;
        if (!mealsByDate.has(date)) mealsByDate.set(date, []);
        mealsByDate.get(date).push({
          id: meal.id,
          name: meal.name,
          cal: meal.calories,
          p: meal.protein,
          c: meal.carbs,
          f: meal.fat,
          e: meal.emoji,
          m: meal.meal_type,
          t: new Date(meal.logged_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        });
      }
    }

    if (Array.isArray(waterResp)) {
      for (const water of waterResp) {
        const date = String(water.log_date || "").slice(0, 10);
        if (!date) continue;
        waterByDate.set(date, Number(water.glasses) || 0);
      }
    }

    // Update results with remote data
    for (const date of dates) {
      const remoteMeals = normalizeMealList(mealsByDate.get(date) || []);
      const remoteWater = waterByDate.get(date) || 0;

      // Update local storage
      saveLocalDay(uid, date, remoteMeals, remoteWater);

      // Update results
      results.set(date, formatDayData(remoteMeals, remoteWater, date));
    }
  } catch (error) {
    // Keep local data on sync failure
  }

  return results;
};

// ═══════════════════════════════════════════════════════════════════════════
// CLEAR CACHE (call on logout)
// ═══════════════════════════════════════════════════════════════════════════

export const clearFetchCache = () => {
  fetchCache.clear();
  fetchInFlight.clear();
};
