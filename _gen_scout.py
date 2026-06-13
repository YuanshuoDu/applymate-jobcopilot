
import os
path = os.path.join('apps', 'worker', 'src', 'queue', 'scout-queue.ts')
lines = []
def add(s):
    lines.append(s)
bs = chr(92)  # backslash
sq = chr(39)  # single quote
dq = chr(34)  # double quote

add('/**')
add(' * Scout queue — automated job discovery via Greenhouse + Lever sources.')
add(' */')
add('import { Queue, Worker } from ' + dq + 'bullmq' + dq)
add('import { Redis } from ' + dq + 'ioredis' + dq)
add('import { getPool } from ' + dq + '../db/apply-results.js' + dq)
add('')
add('const redisUrl = process.env.REDIS_URL ?? ' + dq + 'redis://localhost:6379' + dq)
add('const connection = new Redis(redisUrl, { maxRetriesPerRequest: null })')
add('')
add('export const SCOUT_QUEUE_NAME = ' + dq + 'scout-tasks' + dq)

with open(path, 'w', encoding='utf-8') as f:
    f.write(chr(10).join(lines))
print('header written')
