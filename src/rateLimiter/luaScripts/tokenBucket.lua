-- Atomic token-bucket check-and-consume.
--
-- Why Lua at all: Redis executes a script as a single, uninterruptible
-- operation. That's what makes this "cluster safe" -- it doesn't matter how
-- many app instances call this at the same second, Redis serializes the
-- script executions, so two instances can never both read tokens=1 and both
-- decide "allowed". A naive GET-then-SET from application code would race.
--
-- KEYS[1] = bucket key, e.g. "bucket:{clientId}"
-- ARGV[1] = capacity          (max tokens / burst size)
-- ARGV[2] = refillPerMs        (tokens regenerated per millisecond)
-- ARGV[3] = nowMs              (caller-supplied clock, so tests are deterministic)
-- ARGV[4] = cost                (tokens this request consumes, usually 1)
--
-- Returns: { allowed(0/1), remainingTokens(float, stringified), resetAtMs }

local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local cost       = tonumber(ARGV[4])

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local timeStamp = tonumber(bucket[2])

if tokens == nil then
  -- First time we've seen this client: bucket starts full.
  tokens = capacity
  timeStamp = now
end

-- Refill based on elapsed time since the last check. This is what makes it
-- a *bucket* rather than a fixed window: tokens trickle back continuously
-- instead of resetting in a lump at a window boundary (which would let a
-- client burst 2x the limit right at the boundary).
local elapsed = math.max(0, now - timeStamp)
tokens = math.min(capacity, tokens + elapsed * refillRate)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)

-- Let idle buckets expire instead of leaking memory forever. TTL = time to
-- fully refill from empty, plus a minute of slack.
local ttlSeconds = math.ceil((capacity / refillRate) / 1000) + 60
redis.call('EXPIRE', KEYS[1], ttlSeconds)

local msUntilFull = math.ceil((capacity - tokens) / refillRate)

return { allowed, tostring(tokens), now + msUntilFull }
