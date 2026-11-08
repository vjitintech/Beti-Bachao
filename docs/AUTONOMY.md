# How Beti Bachao protects her automatically

Once she has set up her places, everything below happens without anyone pressing anything more.

## Ways to start an SOS
| Trigger | Android app | iPhone app | Website |
|---|---|---|---|
| Hold SOS button (3 s) | ✅ | ✅ | ✅ |
| Shake 3× | ✅ also when locked | ✅ app open | ✅ app open |
| Voice: "bachao", "help", "kapadandi"… (on-device speech recognition) | ✅ also when locked (Voice SOS on) | ✅ app open · locked: "Hey Siri, Beti Bachao SOS" | Chrome only, app open |
| 3 slow blinks at the front camera (on-device face model) | ✅ Blink SOS screen open | ✅ Blink SOS screen open | ✅ |
| Power button 5×, quick tile, widget, lock-screen button | ✅ | Action Button, Siri, Shortcuts | — |
| Not arriving from a trip and not answering "Are you OK?" | ✅ | ✅ | ✅ |

Shake, voice and blink give her 5 seconds to cancel (avoids false alarms).

## What happens after an SOS, automatically
1. **Contacts by place.** Each saved place (home, college, office…) has 3–5 contacts. The phone texts the contacts for the place she is at; ⭐ important contacts are told every time. If she moves to another saved place during the SOS, that place's contacts are added. Android sends the SMS itself; the server SMS gateway covers iPhone, and covers phones with no SIM or no signal.
2. **Volunteers.** Verified, approved, on-duty volunteers within 10 → 20 → 30 km get an alarm push, and an SMS if they don't respond in 30 s.
3. **Evidence.** 15 s of audio is recorded and sent to the operators, encrypted at rest. It is deleted after 30 days unless held.
4. **Operator clock.** An operator must tap "I'm handling this".
   - **60 s without anyone:** every operator is alerted again.
   - **120 s without anyone, or if she presses SOS a second time:** the **nearest police station is connected automatically**. The station gets an SMS with her name, number and live location link, and an automatic call rings the station and connects it to her phone (Exotel or Twilio). Her Android phone also texts 112. She sees the station's name with a one-tap call button.
   - The same happens if no volunteer accepts within all three search stages and no operator has acted.
5. **Live tracking** until *she* confirms she is safe. Her status is spoken aloud for blind users.

## Track my travel (Disha "Track my travel" / Shakti "safe travel")
Destination + expected time + vehicle number → her contacts get a live link (SMS). The trip ends by itself when she arrives, and her contacts are told she reached safely. If she is late: "Are you OK?" → no answer in 2 minutes → SOS starts with her last location and the vehicle number.

## For blind and low-vision women
- Works with TalkBack and VoiceOver. All screens pass an automated accessibility audit (axe-core, WCAG 2 AA).
- Spoken guidance: speaks every update ("Volunteer A is coming, 1.2 km away, about 4 minutes") and repeats the status every minute.
- Voice commands: tap 🎤 and say "help", "status", "call police" or "I am safe" (closing asks for a spoken "yes I am safe").
- No-look triggers: voice, shake, power button, blink.

## Dashboards
- **Her "My safety"**: set-up checklist, her SOS and trip history, response times, and volunteers on duty and women protected around her home.
- **Admin "Impact"**:
  - women protected, registrations, verified and on-duty volunteers;
  - SOS per day, how SOS ended, operator acknowledgement time;
  - unacknowledged SOS, police auto-connects, volunteer accept/arrival times.
- **Public counter** on the welcome page: women helped to safety, volunteers, safe trips. This encourages women to sign up.

## What you (the owner) must do to make it fully autonomous
Without the items below the app still works, but the part noted on each item stays manual or missing.

| # | Action | Unlocks |
|---|---|---|
| 1 | Deploy the server 24×7 ([DEPLOY.md](DEPLOY.md)) with `DATABASE_URL`, and set `PUBLIC_URL` to its https address | Everything; trip links in SMS |
| 2 | **Police station list**: Admin → Police stations → paste CSV (name, district, lat, lng, phone). Get it from AP Police / district SP offices; check each number | Automatic police connection, "Nearby help" |
| 3 | **Formal agreement with AP Police / Shakti teams and ERSS 112**: stations agree to accept automated SMS and calls from Beti Bachao | Police acting on the automatic alerts |
| 4 | **SMS gateway** (MSG91 + DLT registration of templates SOS, ALERT, OTP, VERIFY, POLICE, TRIP_START, TRIP_SAFE) | Contacts texted for iPhone users, police SMS, trip links |
| 5 | **Voice gateway** (Exotel with a DLT-registered ExoPhone, or Twilio): `VOICE_PROVIDER`, keys | Automatic call connecting the station with her |
| 6 | Firebase (Android) + APNs key (iPhone) | Alarm alerts to volunteers and her |
| 7 | 24×7 operator rota (at least 2 people per shift) | Fewer police auto-connects; human judgement |
| 8 | Play Store (SMS, background location, microphone, full-screen permission declarations) and App Store (TestFlight) | Real distribution |
| 9 | `MEDIA_KEY` and `BACKUP_KEY` stored safely offline | Reading evidence and backups after a server move |
| 10 | Volunteer recruitment through NGOs, colleges and RWAs in the pilot area (e.g. Kurnool) | Someone nearby to come |

No app can call 112 by itself. Police connection uses the station's normal phone number through the voice gateway, and SMS to 112 is sent from her Android phone (ERSS accepts SMS).
