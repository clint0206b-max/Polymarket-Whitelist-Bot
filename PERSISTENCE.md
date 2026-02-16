# Persistence Strategy (v1.0)

## Goal

Prevent data loss and corruption while minimizing disk I/O, ensuring `state/watchlist.json` is always valid even after crashes or kill signals.

## Core Guarantees

1. **Never leaves truncated/invalid JSON on disk**
2. **Crash-safe**: Either old state or new state, never corrupted
3. **Power-loss safe** (with fsync)
4. **Always has `.bak` fallback** if final file is corrupted
5. **Atomic writes** (tmp + rename)

## Implementation

### Atomic Write (state_store.js)

```javascript
writeJsonAtomic(path, obj)
```

**Steps:**
1. **Backup**: Copy current file to `path.bak` (if exists)
2. **Write temp**: Write JSON to `path.tmp`
3. **fsync temp**: Force flush to disk (durability)
4. **Rename**: Atomic rename `path.tmp` → `path` (OS-level atomicity)
5. **fsync dir**: Force directory metadata flush (ensures rename is durable)

**Result**: Either the old file or new file exists, never corrupted.

### Recovery (state_store.js)

```javascript
readJsonWithFallback(path)
```

**Steps:**
1. Try to load primary file
2. If corrupted (invalid JSON), try `.bak`
3. If `.bak` also corrupted, return `null`
4. Log recovery warnings for observability

**Result**: Bot recovers from corrupted state automatically.

### Dirty Tracking (dirty_tracker.mjs)

**Purpose**: Only persist when state has "important" changes.

**Important changes** (immediate persist if critical):
- Status transitions (watching → pending_signal → signaled)
- Markets added/removed from watchlist
- Signals generated (**CRITICAL** - new paper positions)
- Resolutions (**CRITICAL** - paper positions closed)

**Cosmetic changes** (can wait):
- Context cache updates
- Health counters
- Runtime timestamps
- Loop run counters

**Strategy:**
- Mark dirty with reason when important change occurs
- Persist immediately if `critical=true` (new signals, resolutions)
- Otherwise persist every 5s if dirty (throttled)
- Clear dirty after successful write

### Integration (run.mjs)

**Startup:**
```javascript
state = readJsonWithFallback(STATE_PATH) || baseState();
const dirtyTracker = new DirtyTracker();
```

**During loop:**
```javascript
// After each operation, mark dirty
dirtyTracker.mark("gamma:markets_added:3");

// After signal generation, mark CRITICAL
dirtyTracker.mark("eval:signals_generated:2", true);

// At end of cycle, check if should persist
if (dirtyTracker.shouldPersist(now, { throttleMs: 5000 })) {
  writeJsonAtomic(STATE_PATH, state);
  dirtyTracker.clear(now);
}
```

**Shutdown:**
```javascript
finally {
  writeJsonAtomic(STATE_PATH, state); // Always persist on exit
  releaseLock(LOCK_PATH);
}
```

## Throttling Policy

- **Polling**: 2s (unchanged)
- **Persistence (normal)**: 5s throttle (if dirty)
- **Persistence (critical)**: Immediate (new signals, resolutions)
- **Shutdown**: Always persist (no throttle)

**Result**: Typical cycle writes every 5-10s instead of every 2s (reduces I/O by 60-80%).

## Backup Rotation

- **Current state**: `state/watchlist.json`
- **Last known good**: `state/watchlist.json.bak`

**Rotation logic:**
1. Before writing new state, copy current to `.bak`
2. Then write new state atomically
3. If new write fails, `.bak` still contains old valid state

**Recovery scenarios:**
- **Normal startup**: Load `watchlist.json`
- **Corrupted primary**: Load `watchlist.json.bak` (automatic fallback)
- **Both corrupted**: Start fresh (baseState)

## Testing

**Tests**: `tests/persistence.test.mjs` (24 tests)

**Coverage:**
- ✅ Atomic write creates backup
- ✅ Atomic write never leaves .tmp file
- ✅ Recovery from corrupted primary (fallback to .bak)
- ✅ Recovery fails gracefully if both corrupted
- ✅ DirtyTracker mark/shouldPersist/clear logic
- ✅ detectChanges for state comparison

## Performance

**Before:**
- Persist every 2s (30 writes/min)
- No fsync (not durable on power loss)
- No backup (no recovery from corruption)

**After:**
- Persist every ~6s average (10 writes/min)
- fsync enabled (durable on power loss)
- Backup rotation (automatic recovery)
- **I/O reduction: ~67%**

## Future Improvements (Low Priority)

1. **Second backup**: Keep `watchlist.json.bak2` for extra safety
2. **Compression**: gzip backups to save disk space
3. **Checksums**: Add SHA-256 to detect silent corruption
4. **WAL**: Write-ahead log for append-only operations (overkill for current use case)

## References

- Commit: `[TO BE FILLED]`
- Spec: WATCHLIST-SPEC.md (unchanged)
- Tests: tests/persistence.test.mjs
