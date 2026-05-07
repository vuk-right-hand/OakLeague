# Phase 0 — HeyGen LiveAvatar Lite verification

**Date:** 2026-05-06T12:54:49.696Z
**Mode:** `prod` (prod, billable)
**Total wall-clock:** 160059ms
**Verifier:** `scripts/heygen-phase0-verify.mjs` — re-runnable
**Errors:** none

---

## Errors
```json
[]
```

## Measurements
```json
{
  "sessionTokenClaims": {
    "sub": "f7505b58e7cf4b0aae411fddf29ceca5",
    "space_id": "e7b6a8b9e1c24fd9b97ea4cef3fd28a8",
    "session_id": "207f250a-f9ad-4783-a387-3c70cc6de6a2",
    "source": "API",
    "start_session_data": {
      "mode": "LITE",
      "avatar_id": "513fd1b7-7ef9-466d-9af2-344e51eeb833",
      "is_sandbox": false
    },
    "exp": 1778082890
  },
  "livekitClientClaims": {
    "exp": 1778158490,
    "iss": "APIPrDE25vYFWDG",
    "name": "client",
    "nbf": 1778072090,
    "sub": "client",
    "video": {
      "canPublish": true,
      "canPublishData": true,
      "canSubscribe": true,
      "room": "c4f3b6a9-494a-11f1-934c-160c04492a91",
      "roomJoin": true
    }
  },
  "wsUrlHost": "webrtc-signaling.heygen.io",
  "livekitUrlHost": "heygen-feapbkvq.livekit.cloud",
  "maxSessionDurationRequested": null,
  "maxSessionDurationReturned": 1200,
  "wsOpenAtMs": 3713,
  "B_monolith_audio_buffer_appended_ms": {
    "elapsed_ms": 485,
    "t_at": 6217,
    "match": {
      "type": "agent.audio_buffer_appended",
      "event_id": "e4865bcd-9a7e-487d-a8c5-fd02846ac0c6",
      "task": {
        "id": "c75f39ca-cb86-4093-9275-8d65baa31105"
      }
    }
  },
  "B_monolith_speak_started_ms": {
    "elapsed_ms": 269,
    "t_at": 6487,
    "match": {
      "type": "agent.speak_started",
      "event_id": "0abd2f86-47f4-4b01-85c9-122cac57104c",
      "task": {
        "id": "c75f39ca-cb86-4093-9275-8d65baa31105"
      }
    }
  },
  "B_monolith_speak_ended_ms": {
    "elapsed_ms": 1001,
    "t_at": 7488,
    "match": {
      "type": "agent.speak_ended",
      "event_id": "5fa72a3a-b1b2-4790-82a0-91c0f51edf9c",
      "task": {
        "id": "c75f39ca-cb86-4093-9275-8d65baa31105"
      }
    }
  },
  "B_sdk_dts_audio_buffer_appended_ms": {
    "elapsed_ms": 242,
    "t_at": 9736,
    "match": {
      "type": "agent.audio_buffer_appended",
      "event_id": "0998ac98-59ae-46e5-9084-93daacb8cb57",
      "task": {
        "id": "cf428b2f-dadd-4a11-b0c5-9ed5e4041591"
      }
    }
  },
  "B_sdk_dts_speak_started_ms": {
    "elapsed_ms": 311,
    "t_at": 10047,
    "match": {
      "type": "agent.speak_started",
      "event_id": "b139c3c0-43e5-4c88-968d-17993b095295",
      "task": {
        "id": "cf428b2f-dadd-4a11-b0c5-9ed5e4041591"
      }
    }
  },
  "B_sdk_dts_speak_ended_ms": {
    "elapsed_ms": 1000,
    "t_at": 11047,
    "match": {
      "type": "agent.speak_ended",
      "event_id": "61cf9639-adad-49fc-b0cb-86e528942753",
      "task": {
        "id": "cf428b2f-dadd-4a11-b0c5-9ed5e4041591"
      }
    }
  },
  "B_sdk_js_20ms_audio_buffer_appended_ms": {
    "elapsed_ms": 123,
    "t_at": 13173,
    "match": {
      "type": "agent.audio_buffer_appended",
      "event_id": "0f0c583b-0bdc-49a7-a09b-e5305d583ecc",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  "B_sdk_js_20ms_speak_started_ms": {
    "elapsed_ms": 273,
    "t_at": 13446,
    "match": {
      "type": "agent.speak_started",
      "event_id": "1714cc37-93cc-45f9-bb89-2201100ab3a9",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  "B_sdk_js_20ms_speak_ended_ms": {
    "elapsed_ms": 1000,
    "t_at": 14447,
    "match": {
      "type": "agent.speak_ended",
      "event_id": "39da94f5-d2a2-4a2b-9551-3b0241c90fcb",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  "B_barge_first_task_appended_ms": {
    "elapsed_ms": 252,
    "t_at": 16715,
    "match": {
      "type": "agent.audio_buffer_appended",
      "event_id": "553f18fd-cdb6-41dd-a187-c71097940de4",
      "task": {
        "id": "9e743824-4f4f-40e0-ae7a-d05d55a514a6"
      }
    }
  },
  "bargeIn": {
    "first_event_id": "9516caa3-9598-4490-b9fe-b270214461ea",
    "second_event_id": "d9623932-22ad-404d-a7f1-cc4e52512b91",
    "first_task_id": "9e743824-4f4f-40e0-ae7a-d05d55a514a6",
    "frames_after_second": []
  },
  "B_interrupt_audio_buffer_appended_ms": {
    "elapsed_ms": 842,
    "t_at": 27379,
    "match": {
      "type": "agent.audio_buffer_appended",
      "event_id": "f55f6165-ad0b-4bad-9453-d44437f8b743",
      "task": {
        "id": "11cc09ab-56d1-4278-b46a-36cfd9777432"
      }
    }
  },
  "B_interrupt_speak_started_ms": {
    "elapsed_ms": 269,
    "t_at": 27648,
    "match": {
      "type": "agent.speak_started",
      "event_id": "07fdc56e-2631-4771-a466-9ad71c275209",
      "task": {
        "id": "11cc09ab-56d1-4278-b46a-36cfd9777432"
      }
    }
  },
  "interruptSentAtMs": 28453,
  "B_interrupt_to_speak_ended_ms": {
    "elapsed_ms": 355,
    "t_at": 28808,
    "match": {
      "type": "agent.speak_ended",
      "event_id": "36bb2c32-0efc-44a4-afb3-995d8a83f798",
      "task": {
        "id": "11cc09ab-56d1-4278-b46a-36cfd9777432"
      }
    }
  },
  "B_interrupt_latency_ms": 0,
  "B_interrupt_latency_ms_clean": 355,
  "idleCadenceStart": 29106,
  "idleCloseAtMs": null,
  "idleNote": "No close observed after 130s of silence. Server tolerated longer than expected.",
  "stopIdempotency": {
    "first_status": 200,
    "second_status": 200,
    "first_body": {
      "code": 1000,
      "data": null,
      "message": "Successfully stopped session"
    },
    "second_body": {
      "code": 1000,
      "data": null,
      "message": "Successfully stopped session"
    }
  }
}
```

## Inbound WS message types observed (canonical vocabulary)
- `session.state_updated`
- `agent.audio_buffer_appended`
- `agent.audio_buffer_committed`
- `agent.speak_started`
- `agent.speak_ended`
- `agent.idle_started`
- `agent.idle_ended`
- `agent.audio_buffer_cleared`
- `warning`

## Inbound WS frames (first 50)
```json
[
  {
    "t_ms": 3715,
    "label": "main",
    "type": "session.state_updated",
    "frame": {
      "type": "session.state_updated",
      "event_id": "a5369bc8-0e6f-44c5-86f9-e06152762b05",
      "state": "connected"
    }
  },
  {
    "t_ms": 6217,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "e4865bcd-9a7e-487d-a8c5-fd02846ac0c6",
      "task": {
        "id": "c75f39ca-cb86-4093-9275-8d65baa31105"
      }
    }
  },
  {
    "t_ms": 6218,
    "label": "main",
    "type": "agent.audio_buffer_committed",
    "frame": {
      "type": "agent.audio_buffer_committed",
      "event_id": "2e46d212-551f-437c-8bb5-7d0b98aef9ad",
      "task": {
        "id": "c75f39ca-cb86-4093-9275-8d65baa31105"
      }
    }
  },
  {
    "t_ms": 6487,
    "label": "main",
    "type": "agent.speak_started",
    "frame": {
      "type": "agent.speak_started",
      "event_id": "0abd2f86-47f4-4b01-85c9-122cac57104c",
      "task": {
        "id": "c75f39ca-cb86-4093-9275-8d65baa31105"
      }
    }
  },
  {
    "t_ms": 7488,
    "label": "main",
    "type": "agent.speak_ended",
    "frame": {
      "type": "agent.speak_ended",
      "event_id": "5fa72a3a-b1b2-4790-82a0-91c0f51edf9c",
      "task": {
        "id": "c75f39ca-cb86-4093-9275-8d65baa31105"
      }
    }
  },
  {
    "t_ms": 7489,
    "label": "main",
    "type": "agent.idle_started",
    "frame": {
      "type": "agent.idle_started",
      "event_id": "fbeb2513-a566-4116-8659-8cc4cf13b6d7"
    }
  },
  {
    "t_ms": 9736,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "0998ac98-59ae-46e5-9084-93daacb8cb57",
      "task": {
        "id": "cf428b2f-dadd-4a11-b0c5-9ed5e4041591"
      }
    }
  },
  {
    "t_ms": 9855,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "9ccf38d5-ce43-4947-bfca-e44bbe46a638",
      "task": {
        "id": "cf428b2f-dadd-4a11-b0c5-9ed5e4041591"
      }
    }
  },
  {
    "t_ms": 9855,
    "label": "main",
    "type": "agent.audio_buffer_committed",
    "frame": {
      "type": "agent.audio_buffer_committed",
      "event_id": "7d83c8c9-dc62-4cd7-8f49-b305f2b1487d",
      "task": {
        "id": "cf428b2f-dadd-4a11-b0c5-9ed5e4041591"
      }
    }
  },
  {
    "t_ms": 10047,
    "label": "main",
    "type": "agent.idle_ended",
    "frame": {
      "type": "agent.idle_ended",
      "event_id": "057e1a1e-6f6f-407e-845f-6e3990fd8691"
    }
  },
  {
    "t_ms": 10047,
    "label": "main",
    "type": "agent.speak_started",
    "frame": {
      "type": "agent.speak_started",
      "event_id": "b139c3c0-43e5-4c88-968d-17993b095295",
      "task": {
        "id": "cf428b2f-dadd-4a11-b0c5-9ed5e4041591"
      }
    }
  },
  {
    "t_ms": 11047,
    "label": "main",
    "type": "agent.speak_ended",
    "frame": {
      "type": "agent.speak_ended",
      "event_id": "61cf9639-adad-49fc-b0cb-86e528942753",
      "task": {
        "id": "cf428b2f-dadd-4a11-b0c5-9ed5e4041591"
      }
    }
  },
  {
    "t_ms": 11047,
    "label": "main",
    "type": "agent.idle_started",
    "frame": {
      "type": "agent.idle_started",
      "event_id": "f5f057fb-cb93-417b-91fc-96df98dd9c8c"
    }
  },
  {
    "t_ms": 13173,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "0f0c583b-0bdc-49a7-a09b-e5305d583ecc",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13173,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "4e580d38-537a-4cfc-b1a6-acac22d7b90b",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13173,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "8f1a5308-1940-4606-9ae7-b9d68790b615",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13173,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "b74dbe76-e62b-4005-a250-c03ed11ffa18",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13173,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "e57f01f7-6864-454e-9c6a-d4188723835d",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13173,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "680ec6f8-2d8b-4c3d-b3f4-0897db9a1242",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13173,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "5bf70f38-40d5-4bff-812c-7d7d648b7b27",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13174,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "535d6554-2993-4d0e-9003-bdb0ff897818",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13174,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "08593a9a-a28e-46dc-98d1-292c567eb2b1",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13175,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "605b5630-e706-4228-90f4-2f446a1fb9bb",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13177,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "93f10ae8-6b93-4009-829d-8e524c09bda1",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13177,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "00e91e8c-2145-425f-94ce-baf9d38c8671",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13293,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "4ec0c749-f619-41f5-b513-8aacdcd0d628",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "ad5be4a4-ee33-45b0-a668-117bb066826a",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "239f5e18-9c23-437c-865c-a6cb64ce4898",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "8efe945a-2c68-4ee5-a8d5-69c39975372b",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "b656d6e8-0018-47a9-96f2-f236dcd2d7d9",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "4d80fba2-c631-4aed-b8e1-10a7c59db358",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "1a4eff89-0c97-41b3-afa8-c766c734f707",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "3e8234f7-7556-42ad-9a3f-2833a3a8c0fa",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "33d811f6-51a4-44a3-8fc3-f6dc68a5c03a",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "23ff9be8-8075-4eb3-8d84-fd5987d5ac0d",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "8be5455a-252f-4f68-9f5d-b774893eed48",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "0ba741c6-29f0-4a4d-b235-df7d17bbe411",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "f67a6951-4090-4ed7-a80f-2d25f4627435",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "8d80e8b6-11f7-4a74-829c-b12fcd2b05ad",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "31df5ef0-df8e-40e3-970c-8a3f8eb0ae96",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "8852b544-0ea9-4ce2-801f-9829df8a9dc7",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "191cf751-6410-4746-9ed9-1c4f46573e09",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "145dfc2e-e95c-4f35-95bf-f90da70d39db",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "b66f01b5-86f8-4199-af6c-124411269d94",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "5ec1a060-ddea-421e-b369-736ca22c432c",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13294,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "79fa2cc3-c4cd-41a9-8dc4-05fad4b6aa6f",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13342,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "fa3c6e36-0c47-4eb5-a40b-d1e38278de38",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13342,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "64929e10-50e8-408c-b04d-d527db96f0ae",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13342,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "322ee198-359b-4b5c-9d9d-cbe21b9cf1ef",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 13413,
    "label": "main",
    "type": "agent.audio_buffer_appended",
    "frame": {
      "type": "agent.audio_buffer_appended",
      "event_id": "20ec44e3-1328-4766-8144-a2718044e04f",
      "task": {
        "id": "deac6d7d-589e-4f61-a313-cb5a2891c42e"
      }
    }
  },
  {
    "t_ms": 150647,
    "label": "main",
    "type": "<close>",
    "frame": {
      "code": 1000,
      "reason": "",
      "wasClean": true
    }
  }
]
```

## fetch() calls (every URL the script hit, in order)
```json
[
  {
    "url": "https://api.liveavatar.com/v1/avatars/public?page=1&page_size=20",
    "method": "GET",
    "t_ms": 2
  },
  {
    "url": "https://api.liveavatar.com/v1/sessions/token",
    "method": "POST",
    "t_ms": 523
  },
  {
    "url": "https://api.liveavatar.com/v1/sessions/start",
    "method": "POST",
    "t_ms": 776
  },
  {
    "url": "https://api.liveavatar.com/v1/sessions/keep-alive",
    "method": "POST",
    "t_ms": 2912
  },
  {
    "url": "https://api.liveavatar.com/v1/sessions/keep-alive",
    "method": "POST",
    "t_ms": 28808
  },
  {
    "url": "https://api.liveavatar.com/v1/sessions/stop",
    "method": "POST",
    "t_ms": 159338
  },
  {
    "url": "https://api.liveavatar.com/v1/sessions/stop",
    "method": "POST",
    "t_ms": 159873
  }
]
```

## REST steps (verbatim, redacted)
```json
[
  {
    "label": "GET /v1/avatars/public",
    "t_ms": 521,
    "status": 200,
    "body": {
      "code": 1000,
      "data": {
        "count": 83,
        "next": "https://api.liveavatar.com/v1/avatars/public?page=2&page_size=20",
        "previous": null,
        "results": [
          {
            "id": "513fd1b7-7ef9-466d-9af2-344e51eeb833",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Ann Therapist",
            "preview_url": "https://files2.heygen.ai/avatar/v3/75e0a87b7fd94f0981ff398b593dd47f_45570/preview_talk_4.webp",
            "is_expired": false,
            "default_voice": {
              "id": "de5574fc-009e-4a01-a881-9919ef8f5a0c",
              "name": "Ann - IA"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "567e8371-f69f-49ec-9f2d-054083431165",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Ann Doctor Standing",
            "preview_url": "https://files2.heygen.ai/avatar/v3/699a4c2995914d39b2cb311a930d7720_45570/preview_talk_3.webp",
            "is_expired": false,
            "default_voice": {
              "id": "de5574fc-009e-4a01-a881-9919ef8f5a0c",
              "name": "Ann - IA"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "fc9c1f9f-bc99-4fd9-a6b2-8b4b5669a046",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Ann Doctor Sitting",
            "preview_url": "https://files2.heygen.ai/avatar/v3/26de369b2d4443e586dedf27af1e0c1d_45570/preview_talk_1.webp",
            "is_expired": false,
            "default_voice": {
              "id": "de5574fc-009e-4a01-a881-9919ef8f5a0c",
              "name": "Ann - IA"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "7b888024-f8c9-4205-95e1-78ce01497bda",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Shawn Therapist",
            "preview_url": "https://files2.heygen.ai/avatar/v3/db2fb7fd0d044b908395a011166ab22d_45680/preview_target.webp",
            "is_expired": false,
            "default_voice": {
              "id": "51afbab6-7af4-473b-95fc-6ce26aac8bb1",
              "name": "Shawn - IA"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "0930fd59-c8ad-434d-ad53-b391a1768720",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Dexter Lawyer",
            "preview_url": "https://files2.heygen.ai/avatar/v3/e20ac0c902184ff793e75ae4e139b7dc_45600/preview_target.webp",
            "is_expired": false,
            "default_voice": {
              "id": "b952f553-f7f3-4e52-8625-86b4c415384f",
              "name": "Dexter - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "bd43ce31-7425-4379-8407-60f029548e61",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Dexter Doctor Sitting",
            "preview_url": "https://files2.heygen.ai/avatar/v3/f83fffc45faa4368b6db9597e6b323ca_45590/preview_talk_3.webp",
            "is_expired": false,
            "default_voice": {
              "id": "b952f553-f7f3-4e52-8625-86b4c415384f",
              "name": "Dexter - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "5761a14c-8720-4ce1-8c2b-3f351718fc79",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Dexter Doctor Standing",
            "preview_url": "https://files2.heygen.ai/avatar/v3/88d421f939044bb08d892e833931948b_45590/preview_talk_1.webp",
            "is_expired": false,
            "default_voice": {
              "id": "b952f553-f7f3-4e52-8625-86b4c415384f",
              "name": "Dexter - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "0f563214-1cb5-4dc0-a2f9-43f44e5e6b57",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Judy Doctor Standing",
            "preview_url": "https://files2.heygen.ai/avatar/v3/13bc0ed39627493da8404a4beb373f3a_45650/preview_talk_3.webp",
            "is_expired": false,
            "default_voice": {
              "id": "4f3b1e99-b580-4f05-9b67-a5f585be0232",
              "name": "Judy - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "07faa1c4-b7e1-4d26-a38a-337364dee160",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Judy Doctor Sitting",
            "preview_url": "https://files2.heygen.ai/avatar/v3/022cdb1f07914e75887c693f0c5f97dd_45650/preview_talk_1.webp",
            "is_expired": false,
            "default_voice": {
              "id": "4f3b1e99-b580-4f05-9b67-a5f585be0232",
              "name": "Judy - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "6e32f90a-f566-45be-9ec7-a5f6999ee606",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Judy Lawyer",
            "preview_url": "https://files2.heygen.ai/avatar/v3/a7c86cb77b3144948bf8020f6e734bbf_45640/preview_talk_1.webp",
            "is_expired": false,
            "default_voice": {
              "id": "4f3b1e99-b580-4f05-9b67-a5f585be0232",
              "name": "Judy - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "b6c94c07-e4e5-483e-8bec-e838d5910b7d",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Judy Teacher Standing",
            "preview_url": "https://files2.heygen.ai/avatar/v3/6cd7031aa97e496897391dd44dae56be_45630/preview_talk_1.webp",
            "is_expired": false,
            "default_voice": {
              "id": "4f3b1e99-b580-4f05-9b67-a5f585be0232",
              "name": "Judy - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "c72a9099-84b9-4d5d-98f4-a19ba131e654",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Judy Teacher Sitting",
            "preview_url": "https://files2.heygen.ai/avatar/v3/f94ae3e89f4c4ff98541ab59efa5878b_45630/preview_talk_2.webp",
            "is_expired": false,
            "default_voice": {
              "id": "4f3b1e99-b580-4f05-9b67-a5f585be0232",
              "name": "Judy - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "cd1d101c-9273-431b-8069-63beef736bec",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Judy HR",
            "preview_url": "https://files2.heygen.ai/avatar/v3/68fbd9f64a4948baa3c295d35f49b61c_45630/preview_target.webp",
            "is_expired": false,
            "default_voice": {
              "id": "4f3b1e99-b580-4f05-9b67-a5f585be0232",
              "name": "Judy - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "June HR",
            "preview_url": "https://files2.heygen.ai/avatar/v3/74447a27859a456c955e01f21ef18216_45620/preview_talk_1.webp",
            "is_expired": false,
            "default_voice": {
              "id": "62bbb4b2-bb26-4727-bc87-cfb2bd4e0cc8",
              "name": "June - Lifelike"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "9650a758-1085-4d49-8bf3-f347565ec229",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Silas HR",
            "preview_url": "https://files2.heygen.ai/avatar/v3/582ee8fe072a48fda3bc68241aeff660_45660/preview_target.webp",
            "is_expired": false,
            "default_voice": {
              "id": "b139a8fe-7240-4454-ac37-8c68aebcee41",
              "name": "Silas - Lifelike"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "dc2935cf-5863-4f08-943b-c7478aea59fb",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Silas Customer Support",
            "preview_url": "https://files2.heygen.ai/avatar/v3/a1ed8c71e4bf4e6cb9071d2b7cd71e4e_45660/preview_talk_1.webp",
            "is_expired": false,
            "default_voice": {
              "id": "b139a8fe-7240-4454-ac37-8c68aebcee41",
              "name": "Silas - Lifelike"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "64b526e4-741c-43b6-a918-4e40f3261c7a",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Bryan Tech Expert",
            "preview_url": "https://files2.heygen.ai/avatar/v3/33c9ac4aead44dfc8bc0082a35062a70_45580/preview_talk_3.webp",
            "is_expired": false,
            "default_voice": {
              "id": "9c8b542a-bf5c-4f4c-9011-75c79a274387",
              "name": "Bryan - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "55eec60c-d665-4972-a529-bbdcaf665ab8",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Bryan Fitness Coach",
            "preview_url": "https://files2.heygen.ai/avatar/v3/7fbef4dd1d6641bc8777b26a6aaac85e_45580/preview_talk_1.webp",
            "is_expired": false,
            "default_voice": {
              "id": "9c8b542a-bf5c-4f4c-9011-75c79a274387",
              "name": "Bryan - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "8175dfc2-7858-49d6-b5fa-0c135d1c4bad",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Elenora Tech Expert",
            "preview_url": "https://files2.heygen.ai/avatar/v3/cbd4a69890a040e6a0d54088e606a559_45610/preview_talk_3.webp",
            "is_expired": false,
            "default_voice": {
              "id": "254ffe1e-c89f-430f-8c36-9e7611d310c0",
              "name": "Elenora - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          },
          {
            "id": "7299c55d-1f45-482d-915c-e5efdc9dd266",
            "space_id": null,
            "type": "VIDEO",
            "status": "ACTIVE",
            "name": "Elenora Fitness Coach 2",
            "preview_url": "https://files2.heygen.ai/avatar/v3/e097a0182d5e4f5a8dabc656fd39c063_45610/preview_target.webp",
            "is_expired": false,
            "default_voice": {
              "id": "254ffe1e-c89f-430f-8c36-9e7611d310c0",
              "name": "Elenora - Professional"
            },
            "is_1080p": true,
            "created_at": "2025-11-01T02:50:21",
            "updated_at": "2025-11-01T02:50:21",
            "error_message": null
          }
        ]
      },
      "message": null
    },
    "headers": {
      "cf-cache-status": "DYNAMIC",
      "cf-ray": "9f7822c0bcc2e294-BEG",
      "connection": "keep-alive",
      "content-encoding": "gzip",
      "content-type": "application/json",
      "date": "Wed, 06 May 2026 12:54:50 GMT",
      "server": "cloudflare",
      "transfer-encoding": "chunked",
      "x-request-id": "2e1e6ed7-572d-4cd8-ba12-e18fb0160b2e",
      "x-robots-tag": "noindex, nofollow"
    },
    "notes": null
  },
  {
    "label": "POST /v1/sessions/token",
    "t_ms": 775,
    "status": 200,
    "body": {
      "code": 1000,
      "data": {
        "session_id": "207f250a-f9ad-4783-a387-3c70cc6de6a2",
        "session_token": "***REDACTED(453 chars, head=eyJhbG)***"
      },
      "message": "Session token created successfully"
    },
    "headers": {
      "cf-cache-status": "DYNAMIC",
      "cf-ray": "9f7822c38c3be294-BEG",
      "connection": "keep-alive",
      "content-encoding": "gzip",
      "content-type": "application/json",
      "date": "Wed, 06 May 2026 12:54:50 GMT",
      "server": "cloudflare",
      "transfer-encoding": "chunked",
      "x-request-id": "21ab6e5c-804b-4f7d-983b-525eb9ac2285",
      "x-robots-tag": "noindex, nofollow"
    },
    "notes": {
      "request": {
        "mode": "LITE",
        "avatar_id": "513fd1b7-7ef9-466d-9af2-344e51eeb833",
        "is_sandbox": false
      }
    }
  },
  {
    "label": "POST /v1/sessions/start",
    "t_ms": 2911,
    "status": 201,
    "body": {
      "code": 1000,
      "data": {
        "session_id": "207f250a-f9ad-4783-a387-3c70cc6de6a2",
        "livekit_url": "wss://heygen-feapbkvq.livekit.cloud",
        "livekit_client_token": "***REDACTED(377 chars, head=eyJhbG)***",
        "livekit_agent_token": "***REDACTED(397 chars, head=eyJhbG)***",
        "max_session_duration": 1200,
        "ws_url": "wss://webrtc-signaling.heygen.io/v2-alpha/interactive-avatar/session/c4f3b6a9-494a-11f1-934c-160c04492a91"
      },
      "message": "Session created successfully"
    },
    "headers": {
      "cf-cache-status": "DYNAMIC",
      "cf-ray": "9f7822c51fe8e294-BEG",
      "connection": "keep-alive",
      "content-length": "1137",
      "content-type": "application/json",
      "date": "Wed, 06 May 2026 12:54:52 GMT",
      "server": "cloudflare",
      "x-request-id": "0d37463d-b5ca-4afa-a51b-3c6fb9a91d42",
      "x-robots-tag": "noindex, nofollow"
    },
    "notes": null
  },
  {
    "label": "POST /v1/sessions/keep-alive (early)",
    "t_ms": 3196,
    "status": 200,
    "body": {
      "code": 1000,
      "data": null,
      "message": "Success"
    },
    "headers": {
      "cf-cache-status": "DYNAMIC",
      "cf-ray": "9f7822d2abd0aeaa-BEG",
      "connection": "keep-alive",
      "content-length": "45",
      "content-type": "application/json",
      "date": "Wed, 06 May 2026 12:54:52 GMT",
      "server": "cloudflare",
      "x-request-id": "80aa3637-e2f7-4fc1-8c97-893306d2adc8",
      "x-robots-tag": "noindex, nofollow"
    },
    "notes": null
  },
  {
    "label": "POST /v1/sessions/stop (#1)",
    "t_ms": 159873,
    "status": 200,
    "body": {
      "code": 1000,
      "data": null,
      "message": "Successfully stopped session"
    },
    "headers": {
      "cf-cache-status": "DYNAMIC",
      "cf-ray": "9f7826a45f77f969-BEG",
      "connection": "keep-alive",
      "content-encoding": "gzip",
      "content-type": "application/json",
      "date": "Wed, 06 May 2026 12:57:29 GMT",
      "server": "cloudflare",
      "transfer-encoding": "chunked",
      "x-request-id": "5f75a6a9-d0fd-4434-b30d-c74c62ca45d2",
      "x-robots-tag": "noindex, nofollow"
    },
    "notes": null
  },
  {
    "label": "POST /v1/sessions/stop (#2 — idempotency)",
    "t_ms": 160058,
    "status": 200,
    "body": {
      "code": 1000,
      "data": null,
      "message": "Successfully stopped session"
    },
    "headers": {
      "cf-cache-status": "DYNAMIC",
      "cf-ray": "9f7826a7780af969-BEG",
      "connection": "keep-alive",
      "content-encoding": "gzip",
      "content-type": "application/json",
      "date": "Wed, 06 May 2026 12:57:29 GMT",
      "server": "cloudflare",
      "transfer-encoding": "chunked",
      "x-request-id": "82c3c1c4-0dbe-4565-9c92-0bcb8b53c8a9",
      "x-robots-tag": "noindex, nofollow"
    },
    "notes": null
  }
]
```
