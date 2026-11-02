<?php
// php/pd_twitch.php  —  whether Paddy is live on Twitch right now, for <twitch-live> (pd_tags.php).
//
// Twitch's API (helix/streams) is asked at most once every PD_TWITCH_CHECK_SECONDS; every visit
// in between gets the saved answer from PD_TWITCH_CACHE, which staging and the main site share.
// If Twitch can't be reached or isn't set up, the answer is "not live", so a hiccup hides the
// stream instead of showing a dead player.
//
// Needs PD_TWITCH_CLIENT_ID and PD_TWITCH_CLIENT_SECRET in pd_mon_config.php, from an app made at
// dev.twitch.tv/console (any OAuth redirect URL will do, we never send anyone there). The app
// token we get with them is kept in the cache file too, and replaced whenever Twitch stops
// accepting it (they last about two months).

const PD_TWITCH_CHANNEL       = 'paddysdreamland';
const PD_TWITCH_CACHE         = '/home/paddnols/private/pd_twitch_cache.json';
const PD_TWITCH_CHECK_SECONDS = 60;

// ['live' => true/false, 'problem' => why Twitch couldn't be asked, or null]
function pd_twitch_status(): array {
    static $status = null; // asked once per page, however many <twitch-live> tags it has
    if ($status !== null) return $status;

    $file = @fopen(PD_TWITCH_CACHE, 'c+');
    if (!$file) return $status = ['live' => false, 'problem' => "can't open the Twitch cache file"];

    // Only one visit asks Twitch; any arriving meanwhile wait a moment for its answer.
    flock($file, LOCK_EX);
    $cache = json_decode((string) stream_get_contents($file), true);
    $cache = is_array($cache) ? $cache : [];

    if (time() - (int) ($cache['checked_at'] ?? 0) >= PD_TWITCH_CHECK_SECONDS) {
        $cache = ['checked_at' => time()] + pd_twitch_check($cache['token'] ?? null);
        ftruncate($file, 0);
        rewind($file);
        fwrite($file, json_encode($cache));
        fflush($file);
    }
    flock($file, LOCK_UN);
    fclose($file);

    return $status = ['live' => !empty($cache['live']), 'problem' => $cache['problem'] ?? null];
}

// Ask Twitch, with the saved app token if there is one: ['live', 'problem', 'token'].
function pd_twitch_check(?string $token): array {
    if (!defined('PD_TWITCH_CLIENT_ID') || !defined('PD_TWITCH_CLIENT_SECRET')) {
        return ['live' => false, 'problem' => "Twitch isn't set up yet (no client ID and secret)", 'token' => null];
    }

    // A saved token that Twitch turns down (expired, or the secret changed) gets one retry with a new one.
    for ($try = 0; $try < 2; $try++) {
        if (!$token) {
            [$code, $body] = pd_twitch_request('https://id.twitch.tv/oauth2/token', [], [
                'client_id'     => PD_TWITCH_CLIENT_ID,
                'client_secret' => PD_TWITCH_CLIENT_SECRET,
                'grant_type'    => 'client_credentials',
            ]);
            $token = is_string($body['access_token'] ?? null) ? $body['access_token'] : null;
            if (!$token) {
                return ['live' => false, 'problem' => "Twitch didn't give us a token (HTTP $code), check the client ID and secret", 'token' => null];
            }
        }

        [$code, $body] = pd_twitch_request('https://api.twitch.tv/helix/streams?user_login=' . PD_TWITCH_CHANNEL, [
            'Client-Id: ' . PD_TWITCH_CLIENT_ID,
            'Authorization: Bearer ' . $token,
        ]);
        if ($code === 401) {
            $token = null;
            continue;
        }
        if ($code !== 200 || !is_array($body['data'] ?? null)) {
            return ['live' => false, 'problem' => "Twitch couldn't tell us if the stream is live (HTTP $code)", 'token' => $token];
        }

        // Twitch only lists streams that are live right now.
        return ['live' => count($body['data']) > 0, 'problem' => null, 'token' => $token];
    }

    return ['live' => false, 'problem' => 'Twitch keeps turning down our app token', 'token' => null];
}

// GET $url (or POST $form, if given): [HTTP status, the decoded JSON or null]. Status 0 means
// Twitch couldn't be reached in time, which mustn't hold up the page for long.
function pd_twitch_request(string $url, array $headers, ?array $form = null): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT        => 4,
    ]);
    if ($form !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($form));
    }
    $response = curl_exec($ch);
    $code     = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $body = is_string($response) ? json_decode($response, true) : null;
    return [$code, is_array($body) ? $body : null];
}
