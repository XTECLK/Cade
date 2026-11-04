# Demo video

One video, `demo.mp4`, covers the whole story of [DEMO.md](../../DEMO.md). It is
the player at the top of [the home page](../index.html), with an optional still,
`demo.jpg`, shown before it plays. Until it is here the page says "coming soon".

Shot lists (one file per act of the story, plus setup, to cut into the one video), with whose screen to record and the captions, start at
[script-0-setup.md](script-0-setup.md).

No audio is needed. Keep the video small so the page loads quickly:

```
ffmpeg -i raw.mov -vf "scale=1600:-2" -c:v libx264 -crf 26 -preset slow -an -movflags +faststart demo.mp4
```
