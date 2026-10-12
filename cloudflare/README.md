# The show server on the Raspberry Pi

The app runs on the Pi (ssh host `raspberrypi`, Tailscale 100.102.139.79) under pm2, and a
Cloudflare Tunnel on the same Pi serves it at https://show.vortigernindustries.com.

| what            | where on the Pi                                   |
|-----------------|---------------------------------------------------|
| code            | ~/theater-software                                 |
| server          | pm2 process `theater`, port 3400, Whisper tiny.en  |
| tunnel          | pm2 process `theater-tunnel`, config ~/.cloudflared/theater-config.yml |
| show data       | ~/theater-software/show.json and public/audio (NOT overwritten by deploys) |

Both pm2 processes restart on their own and come back after a reboot (pm2 startup is enabled).

## Putting new code on the Pi

From this folder on the Mac:

    npm run deploy

That copies the code over (leaving show.json and the audio files alone), installs any new
packages and restarts the server. Takes about half a minute.

## Looking at it

    ssh -i ~/.ssh/mc_tunnel raspberrypi
    pm2 ls                      # both should say online
    pm2 logs theater            # the server's log
    pm2 logs theater-tunnel     # the tunnel's log
    pm2 restart theater         # if it ever needs a kick

## Things to know

- Lights (sACN) go out on the Pi's network, so the Pi must be on the lighting network at the venue.
- The microphone for the Follow page is whatever computer opens the Follow page in Chrome; it
  streams the audio to the Pi, which runs the smaller Whisper model to keep up.
- Put a login in front of the public address: Cloudflare dashboard -> Zero Trust -> Access ->
  Applications -> Self-hosted -> show.vortigernindustries.com -> Allow only your emails.
  Otherwise anyone with the address can press GO.
- `cloudflare/config.yml` here is only for running the tunnel from the Mac instead. Don't run
  both at once: they'd both answer for the same address.
