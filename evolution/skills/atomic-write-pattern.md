# Skill: Atomic File Write Pattern
Status: promoted
Confidence: 0.92
Source: council-review-round-5

## Rule
File writes must use tmp-file + rename pattern with unique tmp names (PID + timestamp + random suffix).

## Evidence
S-008, T-003, R-006: Fixed tmp filenames cause collision under concurrency. Date.now() alone insufficient at ms resolution.

## Application
Use: `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
Always clean up tmp on failure.
