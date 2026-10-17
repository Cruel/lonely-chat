# Lonely Chat

Lonely Chat produces a simulated audience conversation from live visual and optional audio context. These terms distinguish what the application observes from what it infers and presents.

## Language

**Media input**:
One selected video device or screen/window capture, or one labeled audio capture device. A session can have zero or one video input and zero or more audio inputs.

**Observation**:
Timestamped captured visual or transcribed audio material made available to an inference cycle; observations are not necessarily meaningful events.

**Event**:
A timestamped, structured interpretation of something that occurred in the observed content. Events can refer to a video moment, speech, or a change in context.

**Inference cycle**:
One execution that receives a bounded selection of recent observations and context, then produces validated events and a chat batch.

**Event history**:
The application-owned chronological sequence of validated events and labeled transcripts used to maintain continuity between independent inference cycles.

**Chatter**:
A persistent simulated viewer identity drawn from the configured roster.
_Avoid_: Bot account (Lonely Chat does not need to post as real platform users)

**Chatter roster**:
The configured set of simulated viewer identities available for generating messages, kept stable between sessions unless edited or regenerated.

**Chat batch**:
The validated collection of messages produced by one inference cycle, each with an intended offset in the upcoming playback interval.

**Chat message**:
A text reaction assigned to a chatter and displayed according to the chat scheduler. Its presentation time is independent of the observation time of any referenced event.

**Chat view**:
One presentation of the same scheduled messages in the desktop app, a local browser overlay, or a floating capture window.

**Model installation**:
A verified, application-managed collection of inference model files downloaded from Hugging Face and registered for a particular model role.
