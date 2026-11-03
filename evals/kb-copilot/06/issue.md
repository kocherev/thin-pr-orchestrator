# Remove the unused KB_VOICE setting from the env example and the agent skill

The voice is a per-product setting now. The worker calls `build_session(product.voice)`, no code reads `KB_VOICE`, and `docs/decisions/0003-voice-model.md` says it is gone. But `.env.example` still lists `KB_VOICE=Puck`, and `skills/livekit-agent/SKILL.md` still says the voice comes from `KB_VOICE` with default `Puck`. People set a variable that does nothing, and the default it names is wrong, because the product default is Sulafat.

Done when:
- `.env.example` has no `KB_VOICE`.
- `skills/livekit-agent/SKILL.md` says the voice is the one stored on the product (default Sulafat) and does not mention `KB_VOICE`.
- `docker-compose.yml` is left alone. It is tracked separately.
