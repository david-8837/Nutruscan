# 🔍 COMPREHENSIVE CODE AUDIT REPORT
## NutriScan Mobile App - Full Codebase Review

**Date:** March 24, 2026  
**Audit Level:** SENIOR ENGINEER REVIEW  
**Severity:** CRITICAL & HIGH priority issues detected

---

## ⚠️ EXECUTIVE SUMMARY

**Total Issues Found:** 24  
**CRITICAL (Must Fix Immediately):** 8  
**HIGH (Fix Soon):** 10  
**MEDIUM (Improve):** 6  

**Risk Areas:**
- 🔴 Data Persistence: Meals/water not saving in multiple places
- 🔴 UI State Inconsistency: Direct setState calls bypass persistence layer
- 🟠 Missing Error Handling: Offline queue failures, sync errors
- 🟠 Incomplete Features: Sleep data hardcoded, incomplete water reminder logic
- 🟠 Performance: Unnecessary re-renders, missing dependencies
- 🟡 Code Quality: Duplicate code, missing validation

---

## 1️⃣ CRITICAL BUGS - DATA NOT PERSISTING

### 🔴 BUG #1: Meals from Recommendations Not Saving to DB (CRITICAL)

**Location:** `src/App.jsx` line 1397  
**Severity:** CRITICAL - Meals disappear on app restart

**Problem:**
```javascript
const addRec=r=>{
  setMeals(p=>[...p,{id:Date.now(),name:r.n,cal:r.c,...}]);
  // ❌ Uses setMeals() directly - NOT setMealsAndSave()
  // ❌ No localStorage save
  // ❌ No Supabase insert
  // Result: Meal added to state, visible in UI, but lost on refresh
};
```

**Impact:**
- User clicks "breakfast recommendation" → meal appears in UI
- App restarts → meal is gone
- No error, no indication of failure
- **Affected UI:** Dashboard recommendations (4 sticky cards at bottom)

**Fix:**
```javascript
const addRec=r=>{
  setMealsAndSave(p=>[...p,{
    id:Date.now(),
    name:r.n,
    cal:r.c,
    p:r.p||0,
    c:r.carb||0,
    f:r.f||0,
    t:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),
    e:r.e,
    m:"Snack"
  }]);
  playSfx&&playSfx("success");
  toast(`${r.n} added!`,"✅");
  setSheet(null);
};
```

---

### 🔴 BUG #2: Water Clicks Not Saving (CRITICAL)

**Location:** `src/App.jsx` lines 1640, 1650  
**Severity:** CRITICAL - Water tracking disappears on restart

**Problem:**
```javascript
// Line 1640 - Hydration sheet water drop clicks
onClick={()=>{
  const nw=i<water?i:i+1;
  setWater(nw);  // ❌ Direct setWater - NOT setWaterAndSave
  if(nw===8)toast("💧 Hydration goal reached!","🏆");
}}

// Line 1650 - Add Glass button
onClick={()=>{
  setWater(w=>Math.min(8,w+1));  // ❌ Direct setWater - NOT setWaterAndSave
  toast("Glass logged! 💧","💧");
}}
```

**Impact:**
- User taps water drops/+Glass button → UI updates instantly (appears to work)
- Goes back to Dashboard → water count stays in local state
- Closes and reopens app → water count reverts to last saved value
- No persistence to Supabase
- **Affected:** Hydration sheet

**Fix:**
```javascript
// Replace BOTH instances:
onClick={()=>{
  const nw=i<water?i:i+1;
  setWaterAndSave(nw);  // ✅ Use setter with persistence
  if(nw===8)toast("💧 Hydration goal reached!","🏆");
}}

onClick={()=>{
  setWaterAndSave(w=>Math.min(8,w+1));  // ✅ Use setter with persistence
  toast("Glass logged! 💧","💧");
}}
```

---

### 🔴 BUG #3: Meal Removal Not Saved (CRITICAL)

**Location:** `src/App.jsx` line 1704  
**Severity:** CRITICAL - Deleted meals reappear on refresh

**Problem:**
```javascript
onClick={()=>{
  setMeals(p=>p.filter(m=>m.id!==mealView.id));  // ❌ Direct setState
  toast("Meal removed","🗑️");  // UI shows success but data isn't deleted
  setSheet(null);
  setMealView(null);
}}
```

**Impact:**
- User clicks "Remove" on a meal → UI removes it immediately (appears successful)
- Closes meal detail sheet
- App goes offline, then back online → deleted meal reappears
- Meal still in Supabase because delete wasn't sent
- **Affected:** Meal Detail sheet

**Fix:**
```javascript
onClick={()=>{
  setMealsAndSave(p=>p.filter(m=>m.id!==mealView.id));  // ✅ Proper delete with sync
  toast("Meal removed","🗑️");
  setSheet(null);
  setMealView(null);
}}
```

---

### 🔴 BUG #4: Meal Duplication Not Saved (CRITICAL)

**Location:** `src/App.jsx` line 1705  
**Severity:** CRITICAL - Duplicated meals lost on refresh

**Problem:**
```javascript
onClick={()=>{
  setMeals(p=>[...p,{...mealView,id:Date.now(),...}]);  // ❌ Direct setState
  toast(`${mealView.name} added again!`,"✅");
  setSheet(null);
}}
```

**Impact:**
- User clicks "+ Add Again" on a meal → duplicated meal appears
- Not saved to localStorage or Supabase
- Refresh app → added meal vanishes
- **Affected:** Meal Detail sheet

**Fix:**
```javascript
onClick={()=>{
  setMealsAndSave(p=>[...p,{
    ...mealView,
    id:Date.now(),
    t:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})
  }]);  // ✅ Proper persist
  toast(`${mealView.name} added again!`,"✅");
  setSheet(null);
}}
```

---

### 🔴 BUG #5: Data Clear Not Clearing Legacy LocalStorage (CRITICAL)

**Location:** `src/App.jsx` line 3189, called from Settings  
**Severity:** CRITICAL - Cleared data still visible after refresh

**Problem:**
```javascript
// In Settings component, at onDataCleared callback:
onDataCleared&&onDataCleared();  // Callback from App line 4434

// The callback in App:
onDataCleared={()=>{
  setMeals([]);  // ❌ Only clears state
  setWater(0);   // ❌ Only clears state
  // ❌ Doesn't clear localStorage!
  // ❌ Doesn't clear offline queue!
}}
```

**Impact:**
- User clicks "Clear all data" in Settings
- UI shows empty meals/water
- App restarts
- Old data reappears from localStorage
- Dangerous for privacy/security if user is sharing device
- **Affected:** Settings → Data management

**Fix:**
```javascript
onDataCleared={async()=>{
  // Clear state
  setMeals([]);
  setWater(0);
  
  // Clear localStorage daysfor current user
  if(user?.id){
    const today=ymdLocal(new Date());
    for(let i=0;i<120;i++){
      const date=addDaysStr(today,-i);
      localStorage.removeItem(`nutriscan_local_${user.id}_${date}_meals`);
      localStorage.removeItem(`nutriscan_local_${user.id}_${date}_water`);
      localStorage.removeItem(`nutriscan_sport_${user.id}_${date}`);
    }
  }
  
  // Clear offline queue
  writeOfflineQueue([]);
  
  // Delete from Supabase if online
  if(user?.token&&netOnline()){
    try{
      await supa.del(user.token,"meals",`user_id=eq.${user.id}`);
      await supa.del(user.token,"water_logs",`user_id=eq.${user.id}`);
    }catch(e){
      toast("Could not delete from server (will retry on sync)","⚠️");
    }
  }
  
  toast("All data cleared! 🗑️","✅");
}}
```

---

## 2️⃣ HIGH PRIORITY BUGS

### 🟠 BUG #6: Missing Date Guard in Water/Meal Operations

**Location:** Multiple (lines 1640, 1650, and water dropdown)  
**Severity:** HIGH - Cross-date data contamination

**Problem:**
- Water/meal operations in Dashboard don't check if `selectedDate === today`
- User can modify yesterday's water count
- No warning or validation

**Impact:**
```javascript
// Today is March 24, user selects "Yesterday" (March 23)
onSelectDate(setSelectedDate("2026-03-23"));

// User clicks water drops on Hydration sheet
// Current code applies water to whatever the state says
// Should warn: "Changing past data - save as modification?"
```

**Fix:**
```javascript
const waterClickHandler = (newValue) => {
  const todayKey = ymdLocal(new Date());
  if(String(selectedDate).slice(0,10) !== todayKey){
    toast("ℹ️ You're modifying a past date. Changes will sync.","ℹ️");
  }
  setWaterAndSave(newValue);
};
```

---

### 🟠 BUG #7: Missing Error Boundary for Failed Syncs

**Location:** `src/App.jsx` - all data save functions  
**Severity:** HIGH - Silent failures on network timeout

**Problem:**
```javascript
try{
  await supa.upsert(user.token,"water_logs",payload);
}catch(e){
  enqueueOffline({kind:"water",payload});  // Silently queued
  // ❌ No error logging
  // ❌ No user feedback that sync failed
  // Users think data is saved when it's just queued
}
```

**Impact:**
- Network timeout → meal saved locally but sync fails
- User thinks all is synced
- App crashes or user logs out
- Offline queue data lost irretrievably

**Fix:**
```javascript
try{
  await supa.upsert(user.token,"water_logs",payload);
}catch(e){
  logAppError(e,"water_save_failed"); // Add monitoring
  enqueueOffline({kind:"water",payload});
  
  // Optional: show subtle badge
  if(!online){
    // Already offline, this is expected
  }else{
    // Unexpected failure
    toast("Network error - will retry","⚠️");
  }
}
```

---

### 🟠 BUG #8: Sleep Data Hardcoded (Not Real)

**Location:** `src/App.jsx` lines 1419, 1663  
**Severity:** HIGH - Misleading feature

**Problem:**
```javascript
const SLEEP=[
  {d:"Mon",h:7.2},  // ❌ HARDCODED
  {d:"Tue",h:6.8},  // ❌ Same data every load
  {d:"Wed",h:8.1},
  {d:"Thu",h:7.5},
  {d:"Fri",h:6.5},
  {d:"Sat",h:8.8},
  {d:"Sun",h:7.9}
];
```

- User sees "Sleep Quality" card with fake data
- Clicking opens sleep sheet with hardcoded chart
- No actual sleep tracking implemented
- Misleads users into thinking feature works

**Impact:**
- Users see fake sleep data
- Feature appears complete but isn't
- No actual sleep integration

**Fix:** Either:
1. Remove feature until implemented, OR
2. Add real sleep data tracking:
   ```javascript
   const fetchSleepData = async () => {
     if(!user?.token || !user?.id) return;
     const lastWeek = dateRangeInclusive(ymdLocal(new Date()), 7);
     const data = await supa.select(
       user.token,
       "sleep_logs",
       "logged_date,hours,quality",
       `&user_id=eq.${user.id}&logged_date=in.(${lastWeek.map(d=>`"${d}"`).join(",")})`
     );
     setSleepData(data || []);
   };
   ```

---

### 🟠 BUG #9: Offline Queue Persistence Not Verified

**Location:** `src/App.jsx` offline queue logic  
**Severity:** HIGH - Data loss on app crash during sync

**Problem:**
```javascript
const flushOfflineQueue = async(user,toast)=>{
  const queue=readOfflineQueue();
  if(!queue?.length)return;
  
  for(const op of queue){
    try{
      // Process operation
      await supa.insert(...);  // If app crashes here, position lost
    }catch(e){
      // Retry on next flush, but index not saved
    }
  }
  writeOfflineQueue([]);  // Only clears AFTER all succeed
}
```

**Issue:**
- If app crashes mid-sync, queue position lost
- Duplicate saves possible on retry
- No idempotency check

**Fix:**
```javascript
const flushOfflineQueue = async(user,toast)=>{
  const queue=readOfflineQueue();
  if(!queue?.length)return;
  
  let failedOps=[];
  for(let i=0;i<queue.length;i++){
    const op=queue[i];
    try{
      await flushSingleOp(op,user);
      // Mark as processed locally
      localStorage.setItem(`nutriscan_sync_checkpoint_${user.id}`,String(i+1));
    }catch(e){
      // Keep remaining for retry
      failedOps.push(...queue.slice(i));
      break;
    }
  }
  
  writeOfflineQueue(failedOps.length>0?failedOps:[]);
};
```

---

### 🟠 BUG #10: Missing Dependency in useEffect for Meal Sync

**Location:** `src/App.jsx` line 4134  
**Severity:** HIGH - Stale closure bug

**Problem:**
```javascript
useEffect(()=>{
  if(screen!=="app"||!user?.id)return;
  loadUserData(user.token,user.id,selectedDate);
},[screen,user?.id,user?.token,selectedDate]);  // ✅ Looks good but...
```

**The Real Issue:**
In `loadUserData()`, it passes `selectedDate` as:
```javascript
const loadUserData=async(token,uid,forDate=selectedDate)=>{
  // forDate parameter uses selectedDate from closure
  // When called from sync effect, selectedDate is captured at effect time
  // But forDate is used INSIDE async callbacks later
  // If selectedDate changes while async is pending, forDate is stale
}
```

**Impact:**
User rapidly switches dates → old date's data overwrites new date

**Fix:**
```javascript
useEffect(()=>{
  if(screen!=="app"||!user?.id)return;
  const currentDate=String(selectedDate).slice(0,10);  // Capture NOW
  
  const load=async()=>{
    const requestId=++loadUserDataReqRef.current;
    const localState=loadLocalDay(user.id,currentDate);  // Use captured
    // ... rest of function
  };
  load();
},[screen,user?.id,user?.token,selectedDate]); // selectedDate in deps is correct
```

---

## 3️⃣ MEDIUM PRIORITY ISSUES

### 🟡 BUG #11: Missing LoadingState During Sync

**Location:** Dashboard doesn't show if syncing with Supabase  
**Severity:** MEDIUM - UX clarity

**Current State:**
```javascript
{tab==="dashboard" && <Dashboard ... selectedDate={selectedDate} onSelectDate={setSelectedDate}/>}
```

Dashboard receives `selectedDate` but no `isSyncing` prop.

**Fix:**
```javascript
const [syncingDate,setSyncingDate]=useState(null);

// In loadUserData, call:
setSyncingDate(dateKey);  // When starting fetch
setSyncingDate(null);     // When done

// Pass to Dashboard:
{tab==="dashboard" && <Dashboard 
  ... 
  selectedDate={selectedDate} 
  onSelectDate={setSelectedDate}
  isSyncingDate={syncingDate}  // ← Add this
/>}

// In Dashboard:
{isSyncingDate===selectedDate && <span>⟳ Syncing...</span>}
```

---

### 🟡 BUG #12: No Validation on Weight Input

**Location:** `src/App.jsx` BMI sheet weight log  
**Severity:** MEDIUM - Bad data

**Current:**
```javascript
const w=parseFloat(weightLogVal);
if(!isFinite(w)||w<=0||w>400){  // ✅ Validation exists
  toast("Enter a valid weight (kg)","❌");
  return;
}
```

**Missing:**
- No decimal place limit (could be 123.456789 kg)
- No age/gender sanity checks
- No comparison to previous weight (alert if +/- 10kg jump)

**Fix:**
```javascript
const w=parseFloat(weightLogVal);
const wRounded=Math.round(w*10)/10;  // 1 decimal place

if(!isFinite(w)||w<=0||w>250){  // Stricter upper bound
  toast("Enter a valid weight (kg)","❌");
  return;
}

// Check sanity vs last logged
if(lastLoggedWeight){
  const delta=Math.abs(lastLoggedWeight-w);
  if(delta>15){  // 15kg jump
    toast(`⚠️ That's a ${delta.toFixed(1)}kg change. Confirm?`,"⚠️");
    // Require confirmation
    return;
  }
}

await supa.upsert(...,{weight:wRounded,...});
```

---

### 🟡 BUG #13: Missing Meal Serving Size Editor

**Location:** Scanner/meal add  
**Severity:** MEDIUM - Accuracy

**Current:**
- No way to modify portion after selection
- User searches "Chicken" → 100g suggested
- But user actually ate 150g → data inaccurate
- No edit button in meal log

**Fix:**
```javascript
// Add to Meal Detail sheet:
<label>Serving Size</label>
<input 
  type="number" 
  value={mealServing} 
  onChange={e=>{
    const newCal=Math.round((mealView.cal/100)*parseFloat(e.target.value));
    setMealView({
      ...mealView,
      cal:newCal,
      p:Math.round(mealView.p/100*parseFloat(e.target.value)),
      c:Math.round(mealView.c/100*parseFloat(e.target.value)),
      f:Math.round(mealView.f/100*parseFloat(e.target.value))
    });
  }}
/>
<p>Originally: 100g</p>
```

---

### 🟡 BUG #14: No Macro Target Customization

**Location:** Calorie target editor  
**Severity:** MEDIUM - Feature incomplete

--

**Current:**
```javascript
const macroTargets=tgt=>({
  tP:Math.round(tgt*.25/4),   // Hardcoded 25% protein
  tC:Math.round(tgt*.5/4),    // Hardcoded 50% carbs
  tF:Math.round(tgt*.25/9)    // Hardcoded 25% fat
});
```

Users can't customize macro split (25/50/25 is just a default ratio).

**Fix:**
Add to Settings:
```javascript
{sheet==="macroPrefs"&&<Sheet>
  <label>Protein Target</label>
  <div>{macroRatio.protein}% ({proteinGrams}g)</div>
  <input type="range" min="15" max="40" 
    onChange={e=>setMacroRatio({...macroRatio,protein:+e.target.value})}/>
  
  <label>Carbs Target</label>
  <div>{macroRatio.carbs}%</div>
  <input type="range" min="30" max="65" />
  
  <label>Fats Target</label>
  <div>{macroRatio.fats}%</div>
  <input type="range" min="15" max="35" />
</Sheet>}
```

---

### 🟡 BUG #15: Analytics Data Not Date-Filtered

**Location:** Analytics screen  
**Severity:** MEDIUM - Shows all-time data as weekly

**Current:**
```javascript
function Analytics({user}){
  // Shown: last 7 days
  // But no parameter passed for fetching
  // Fetches... undefined scope?
}
```

Likely fetches all meals ever, then renders last 7 days.

**Fix:**
```javascript
function Analytics({user}){
  const [analyticsData,setAnalyticsData]=useState(new Map());
  const [loading,setLoading]=useState(true);
  
  useEffect(()=>{
    if(!user?.id) return;
    setLoading(true);
    
    const dates=dateRangeInclusive(ymdLocal(new Date()),30);
    getBatchDayData(dates,user.token,user.id,supabaseClient)
      .then(dataMap=>{
        setAnalyticsData(dataMap);
        setLoading(false);
      });
  },[user?.id]);
  
  if(loading) return <Loading/>;
  
  // Use analyticsData instead of calculating on the fly
  const chartData=Array.from(analyticsData).map(([d,x])=>({...}));
}
```

---

### 🟡 BUG #16: No Duplicate Meal Detection in Scanner

**Location:** Scanner, after food search  
**Severity:** MEDIUM - User experience

**Current:**
- User logs "Chicken Breast" at 12:30pm
- User logs "Chicken Breast" at 12:31pm (duplicate click)
- No warning, both saved
- Stats show double meal

**Fix:**
```javascript
const onAddMeal=(meal)=>{
  const existingToday=meals.filter(m=>
    m.name===meal.name && 
    m.cal===meal.cal &&
    new Date(m.t).getHours()===new Date().getHours()
  );
  
  if(existingToday.length>0){
    toast("ℹ️ You just logged this meal. Add again?","❓");
    // Or show confirm dialog
    return;
  }
  
  setMealsAndSave([...meals,meal]);
};
```

---

## 4️⃣ CODE QUALITY ISSUES

### 🟡 BUG #17: Duplicate Calculation of Calories

**Location:** Multiple places in Dashboard  
**Severity:** LOW - Code smell

**Current:**
```javascript
const eaten=meals.reduce((a,m)=>a+(+m.cal||0),0);  // Line 1555
// ... used in stats
// ... passed to syncMealWaterReminders
// ... recalculated in Analytics
// ... recalculated in Charts

// Each place does the same sum independently
```

**Fix:** Create helper:
```javascript
const calculateDayNutrition=(meals)=>({
  calories:meals.reduce((a,m)=>a+(+m.cal||0),0),
  protein:meals.reduce((a,m)=>a+(+m.p||0),0),
  carbs:meals.reduce((a,m)=>a+(+m.c||0),0),
  fats:meals.reduce((a,m)=>a+(+m.f||0),0),
});

// Use everywhere:
const dayNutr=useMemo(()=>calculateDayNutrition(meals),[meals]);
const eaten=dayNutr.calories;  // Instead of recalculating
```

---

### 🟡 BUG #18: Avatar Cooldown Check Has Race Condition

**Location:** `src/App.jsx` avatar upload  
**Severity:** LOW - Can upload twice in 14 days if rapid clicks

**Problem:**
```javascript
const remainingMs=getAvatarRemainingMs(user.lastAvatarUpdate);
if(remainingMs>0){
  toast(`Avatar update available in ${remainingDaysLabel(remainingMs)} days`,"⏳");
  return;  // ✅ Correct
}

// User rapidly clicks upload button twice
// First upload proceeds
// Second click already passed the check above
```

**Fix:**
```javascript
const [avatarUploading,setAvatarUploading]=useState(false);

const uploadAvatar=async(blob)=>{
  const remainingMs=getAvatarRemainingMs(user.lastAvatarUpdate);
  if(remainingMs>0||avatarUploading){  // Check uploading flag
    toast(`Avatar update available in ${remainingDaysLabel(remainingMs)} days`,"⏳");
    return;
  }
  
  setAvatarUploading(true);
  try{
    // upload logic
  }finally{
    setAvatarUploading(false);
  }
};
```

---

## 5️⃣ EDGE CASES NOT HANDLED

### 🟡 BUG #19: No Retry for Failed Image Upload

**Location:** Profile image upload  
**Severity:** MEDIUM - Silent failure

**Current:**
```javascript
try{
  const signedUrl=await supa.storagePublicUrl(...);
  await fetch(...,{method:"PUT",body:blob});
  // ❌ If fetch fails, no retry
}catch(e){
  toast("Upload failed","❌");
  // User has to manually retry
}
```

---

### 🟡 BUG #20: No Check for Sensor Permission Denial

**Location:** stepCounter.js permission handling  
**Severity:** MEDIUM - Unclear error messages

```javascript
const perm=await StepCounter.requestPermission().catch(()=>null);
if(!perm?.permissionGranted){
  return {ok:false,reason:"permission"};
}
// ❌ No indication of HOW to grant permission
```

**Fix:**
```javascript
if(!perm?.permissionGranted){
  toast("Activity recognition permission required. Check Settings → Apps → NutriScan → Permissions","⚠️");
  return {ok:false,reason:"permission"};
}
```

---

## 6️⃣ INCOMPLETE FEATURES

### 🟡 BUG #21: AI Chat Not Integrated into Insight Feature

**Location:** Dashboard has AI feed placeholder, no backend  
**Severity:** MEDIUM - Dead feature

**Current:**
- "Health Insights" setting exists
- Toggle in Settings works
- But no actual AI insights shown/generated
- Feature appears complete but isn't

---

### 🟡 BUG #22: Search History Not Cached Properly

**Location:** `src/App.jsx` FOOD_SEARCH_CACHE  
**Severity:** LOW - Performance

```javascript
const FOOD_SEARCH_CACHE=new Map();  // In-memory
const FOOD_SEARCH_CACHE_KEY="nutriscan_food_search_cache_v1";
const FOOD_SEARCH_CACHE_TTL_MS=24*60*60*1000;
```

**Issue:**
- Cache in both memory AND localStorage
- No consistency logic: if in-memory expires, doesn't check localStorage
- On reload, loses all in-memory cache

**Fix:**
```javascript
const getCachedSearch=(query)=>{
  // Check memory first
  if(FOOD_SEARCH_CACHE.has(query)){
    const cached=FOOD_SEARCH_CACHE.get(query);
    if(Date.now()-cached.ts<CACHE_TTL){
      return cached.data;
    }
  }
  
  // Check localStorage
  try{
    const stored=JSON.parse(localStorage.getItem(FOOD_SEARCH_CACHE_KEY))||{};
    if(stored[query]&&Date.now()-stored[query].ts<CACHE_TTL){
      FOOD_SEARCH_CACHE.set(query,stored[query]);
      return stored[query].data;
    }
  }catch(e){}
  
  return null;
};
```

---

### 🟡 BUG #23: No Streak Calculation for Water

**Location:** `src/App.jsx` notifications  
**Severity:** MEDIUM - Feature incomplete

**Current:**
- Meal streak calculated and displayed
- Water streak not tracked
- Could encourage consistency if shown

---

### 🟡 BUG #24: One-Way Sync Only (App → Supabase)

**Location:** All sync points  
**Severity:** MEDIUM - No server-client conflict resolution

**Current:**
- Local state is source of truth
- Supabase is backup
- If Supabase data is updated externally (web dashboard), local won't know

**Example:**
1. Mobile logs meal (synced to Supabase)
2. User logs into web dashboard, edits/deletes meal
3. Mobile app has no way to know meal was deleted on server
4. Next sync overwrites web deletion with local data

**Fix:** Add sync conflict detection:
```javascript
const syncWithConflictResolution=async(localData,remoteData)=>{
  // If timestamps differ significantly
  if(Math.abs(localData.ts-remoteData.ts)>5000){  // >5sec difference
    // Remote is newer → use remote
    if(remoteData.ts>localData.ts){
      return remoteData;
    }
  }
  // Same timestamp → merge by dedup
  return normalizeMealList([...localData,...remoteData]);
};
```

---

## SUMMARY TABLE

| # | BUG | Severity | Type | Line | Impact |
|---|-----|----------|------|------|--------|
| 1 | Recommendations not saved | CRITICAL | Logic | 1397 | Meals lost on restart |
| 2 | Water clicks not saved | CRITICAL | Logic | 1640, 1650 | Water tracking reverts |
| 3 | Meal removal not saved | CRITICAL | Logic | 1704 | Deleted meals reappear |
| 4 | Meal duplicate not saved | CRITICAL | Logic | 1705 | Duplicated meals lost |
| 5 | Clear data incomplete | CRITICAL | Logic | 3189 | Data not fully deleted |
| 6 | Missing date guard | HIGH | Logic | Multiple | Cross-date contamination |
| 7 | Silent sync failures | HIGH | Error | Multiple | Data loss risk |
| 8 | Sleep hardcoded | HIGH | Feature | 1419 | Misleading UI |
| 9 | Offline queue unsafe | HIGH | Logic | ~500s | Duplicate saves possible |
| 10 | Stale closure in useEffect | HIGH | Logic | 4134 | Race condition bug |
| 11 | No sync loading state | MEDIUM | UX | Dashboard | Unclear if syncing |
| 12 | Weight no decimal limit | MEDIUM | Logic | 1680+ | Bad data |
| 13 | No serving size edit | MEDIUM | Feature | Scanner | Accuracy issues |
| 14 | Macro ratio hardcoded | MEDIUM | Feature | Macros | No customization |
| 15 | Analytics unfilteret | MEDIUM | Logic | Analytics | Wrong data shown |
| 16 | No duplicate meal warning | MEDIUM | UX | Scanner | Accidental duplicates |
| 17 | Duplicate calculations | LOW | Code Smell | Multiple | Maintenance burden |
| 18 | Avatar cooldown race | LOW | Logic | Avatar | Can upload twice |
| 19 | Image upload no retry | MEDIUM | Error | Upload | Silent failure |
| 20 | Unclear permission errors | MEDIUM | UX | stepCounter | Users confused |
| 21 | AI insights not implemented | MEDIUM | Feature | Dashboard | Dead feature |
| 22 | Search cache inconsistent | LOW | Logic | ~1775 | Cache misses |
| 23 | Water streak missing | MEDIUM | Feature | Notifications | Incomplete |
| 24 | One-way sync only | MEDIUM | Architecture | Sync | Conflicts possible |

---

## RECOMMENDED FIXES (PRIORITY ORDER)

### Phase 1 - CRITICAL (Do First - Blocks App)
1. Fix addRec (rec. meals) → use setMealsAndSave
2. Fix water clicks → use setWaterAndSave
3. Fix meal removal → use setMealsAndSave
4. Fix meal duplication → use setMealsAndSave
5. Fix clear data → clear localStorage + offline queue

**Time: 30 minutes**

### Phase 2 - HIGH (Do Next - Core Features)
6. Add date guard for modifications
7. Add error logging for sync failures
8. Remove sleep feature or implement real tracking
9. Fix offline queue persistence
10. Review useEffect dependency closure

**Time: 1-2 hours**

### Phase 3 - MEDIUM (Do Soon - Polish)
- Add sync loading indicators
- Validate weight input
- Implement serving size editor
- Filter analytics by date range
- Add duplicate meal detection
- Fix search cache logic
- Add permission error messages

**Time: 2+ hours**

### Phase 4 - NICE TO HAVE
- Implement water streak tracking
- Add conflict resolution in sync
- Implement real sleep tracking
- Complete AI insights feature

---

**Next Steps:** Start with Phase 1 CRITICAL fixes immediately. These are data-loss bugs that affect core functionality.
