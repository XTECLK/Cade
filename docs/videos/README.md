# Demo video

One video, `demo.mp4`, is the player at the top of [the home page](../index.html),
with an optional still, `demo.jpg`, shown before it plays. Until it is here the
page says "coming soon".

Its script, with every message to send as Randil (developer) and Udara (client),
step by step, is [demo-script.md](demo-script.md).

A second video, `mcp.mp4`, shows Randil's AI agent finding the discussions that
should be tasks, making one and taking it on. It plays in the "Bring your own
agent" part of the home page; its script is [agent-script.md](agent-script.md).

No audio is needed. Keep the video small so the page loads quickly:

```
ffmpeg -i raw.mov -vf "scale=1600:-2" -c:v libx264 -crf 26 -preset slow -an -movflags +faststart demo.mp4
```
