Resume M5-to-Dexie migration for packages/web-agent.                           
                                                                                
Step 1 — Read durable steering in this order:                                  
  1. CLAUDE.md (repo root)                                                     
  2. ai-docs/milestones.md — M0–M5 done; we are NOT opening a new milestone,   
      this is a storage-layer swap inside M5.                                 
  3. ai-docs/plans/indexeddb-dexie-for-session.md — full approved plan.        
      Follow the phase order; each phase has its own gate.                    
  4. ai-docs/05-decisions.md — D1–D12 landed; D13/D14/D15 land with this       
commit.                                                                      
  5. ai-docs/02-architecture.md (ZenFS mount layout section — the /sessions  
      mount is about to go away) and ai-docs/04-principles.md (storage is IDB,  
      never OPFS; interface + implementation loosely coupled).
                                                                                
Step 2 — Read the current web-agent shape you're about to touch. In parallel:
  - packages/web-agent/src/web-agent/core/session/session-manager.ts           
    (file factories + parseJsonl + write-chain all disappear in Phase 2)       
  - packages/web-agent/src/web-agent/core/session/types.ts                     
    (entry union stays; SessionSummary + SessionRow schemas shift to epoch-ms) 
  - packages/web-agent/src/web-agent/core/session/ids.ts (reused as-is)        
  - packages/web-agent/src/web-agent/worker/worker-host.ts                     
    (SESSIONS_MOUNT + initSessions + IndexedDB import all disappear)           
  - packages/web-agent/src/web-agent/worker/agent-worker.ts                    
    (drop host.initSessions(); construct DexieSessionStore and pass it in)     
  - packages/web-agent/src/hooks/useAgent.ts                                   
    (drop sessionSummaries state + refreshSessions; consume useSessionsList)   
  - packages/web-agent/src/components/sessions/SessionPicker.tsx               
    (drop onRefresh prop)                                                      
  - packages/web-agent/src/components/chat/ChatDemo.tsx                        
    (drop onRefresh wire-up)                                                   
  - packages/web-agent/src/web-agent/core/session/session-manager.test.ts      
    and packages/web-agent/src/web-agent/worker/worker-host.test.ts            
    (rewrite against MemorySessionStore in Phase 2 + Phase 3)                  
  - packages/web-agent/src/web-agent/rpc/rpc.test.ts                           
    (fake host's /sessions string literals get trimmed)                        
  - packages/web-agent/src/web-agent/index.ts                                  
    (drop SESSIONS_MOUNT export; add SessionStore / DexieSessionStore /        
    MemorySessionStore / SessionRow / EntryRow exports)
                                                                                
Step 3 — Read Dexie v4 API you'll use:                                         
  - node_modules/dexie/dist/dexie.d.ts — Dexie class, Table, version().stores()
  - node_modules/dexie/dist/live-query.d.ts — liveQuery observable             
  - node_modules/dexie-react-hooks/dist/useLiveQuery.d.ts — React hook         
                                                                                
Step 4 — confirm installed deps + uncommitted working tree:                    
  - cd packages/web-agent && grep dexie package.json                           
    (expected: dexie ^4.4.2, dexie-react-hooks ^1.1.7, both in dependencies)   
  - git status should show:                                                    
    modified: packages/web-agent/package.json                                  
    modified: packages/web-agent/package-lock.json                             
    modified: packages/web-agent/src/components/chat/ChatDemo.tsx
    modified: packages/web-agent/src/components/sessions/SessionPicker.tsx     
    new:      ai-docs/plans/indexeddb-dexie-for-session.md                     
    untracked: ai-docs/resume.md (this prompt)                                 
  - No other uncommitted source changes.                                       
                                                                                
Step 5 — Create a TaskCreate list mirroring the 6 phases in the plan and       
start Phase 0 (SessionStore interface + MemorySessionStore + its test).        
                                                                                
Gates (run after each phase):                                                  
  cd packages/web-agent && npm run check   # lint + tsc -b
  cd packages/web-agent && npm test         # vitest — 103 existing + new      
                                                                                
Must stay green: all existing 103 vitests + 3 e2e specs. Do not modify         
existing specs unless the phase plan explicitly says so (Phase 2 and 3 rewrite 
session-manager.test + worker-host.test against MemorySessionStore).
                                                                                
Final commit at end covers all 6 phases; checkpoint commits are OK if any      
phase takes more than a day.                                                   
                                                                                
Decision records D13/D14/D15 to append in Phase 5:
  - D13: SessionStore interface for storage swap-out.                          
  - D14: Dexie on IndexedDB for session storage; supersedes D12.
  - D15: Worker owns writes, main reads directly via Dexie liveQuery.          
                                                                                
If anything in the plan looks ambiguous or contradicts the current code        
state, stop and ask before deviating.                                          
