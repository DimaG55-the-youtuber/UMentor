# UMentor MVP

UMentor is a Flask + Socket.IO tutoring app with:

- Parent/Kid account flows
- Real-time user presence and call signaling
- WebRTC video calls
- Live transcription during calls
- In-call AI assistant
- Safety moderation (profanity policy)

## Tech Stack

- Backend: Flask, Flask-SocketIO (eventlet), Flask-Login, Flask-SQLAlchemy
- Frontend: Vanilla JS + WebRTC
- STT provider: AssemblyAI (default), Gemini fallback
- Realtime: Socket.IO events for call lifecycle and signaling

## Quick Start (Windows / PowerShell)

1. Create and activate a virtual environment.

1. Install dependencies:

```powershell
pip install -r requirements.txt
```

1. Create your env file:

```powershell
Copy-Item .env.example .env
```

1. Fill required values in `.env` (especially secrets and API keys).

1. Run the app:

```powershell
python .\app.py
```

App default URL: `http://localhost:5000`

## Environment Variables

Core:

- `SECRET_KEY`
- `FLASK_ENV` (`development` or `production`)
- `DATABASE_URL` (optional; SQLite is default)

Transcription:

- `TRANSCRIBE_PROVIDER` (`assemblyai` or `gemini`)
- `ASSEMBLYAI_API_KEY`
- `ASSEMBLYAI_SPEECH_MODEL` (default: `universal-2`)
- `ASSEMBLYAI_LANGUAGE_CODE` (optional)
- `ASSEMBLYAI_FILTER_PROFANITY` (`true` or `false`)
- `GOOGLE_API_KEY` (only required when using Gemini)

Mail (optional but used by parent/kid flows):

- `MAIL_SERVER`, `MAIL_PORT`, `MAIL_USE_TLS`
- `MAIL_USERNAME`, `MAIL_PASSWORD`
- `MAIL_DEFAULT_SENDER`, `MAIL_SUPPRESS_SEND`

## Call Transcription Flow

1. Browser records short microphone segments.
2. Client sends audio to `POST /api/transcribe`.
3. Backend transcribes using configured provider.
4. Transcript is shown in-call and mirrored to peer via DataChannel.

## Safety: Profanity Moderation

Profanity filtering and enforcement are enabled with AssemblyAI:

- AssemblyAI profanity filtering is requested in transcription config.
- If transcript contains censorship markers (asterisks), policy is triggered.
- Backend force-ends the active call room for both participants.
- Client also has local protection, but backend is authoritative.

## Cloudflare Quick Tunnel

Start tunnel (after app is running on port 5000):

```powershell
.\cloudflared.exe tunnel --url http://localhost:5000 --logfile .\cloudflared.log
```

Restart both app and tunnel:

```powershell
Get-Process -Name python,cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
& .\.venv\Scripts\python.exe .\app.py *> server.log
```

In another terminal:

```powershell
.\cloudflared.exe tunnel --url http://localhost:5000 --logfile .\cloudflared.log
```

## Troubleshooting

- If call transcript fails intermittently, inspect browser debug logs (`DBG` button on call page).
- If Cloudflare shows origin refusal, verify app is listening on port 5000.
- If startup log in PowerShell shows `NativeCommandError` while app still serves requests, treat it as PowerShell stream handling noise and verify with request logs.

## Project Structure

- `app.py`: app factory + server entry point
- `config.py`: configuration and env mapping
- `routes.py`: HTTP routes and APIs
- `sockets.py`: Socket.IO handlers and call state management
- `static/js/call.js`: WebRTC, transcription, call moderation on client
- `templates/`: HTML templates
