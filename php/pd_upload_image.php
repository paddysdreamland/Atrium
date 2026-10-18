<?php
declare(strict_types=1);

// php/pd_upload_image.php  —  image uploads for the post and About Us editors (Moderators and up).
//
// POST multipart/form-data with one file field, "image".
// -> {"ok": true, "src": "images/uploads/<discord id>/<random>.png", "width": ..., "height": ...}
//
// The client's filename and claimed type are ignored: the type is read from the file's
// bytes, the name is random, and PNG/JPEG/WebP are re-encoded with GD, which throws away
// anything smuggled inside the file along with EXIF metadata (phone photos carry GPS).
// GIFs are stored as-is so animations survive. images/uploads/.htaccess makes sure
// nothing in there is ever served as anything but an image.
// Call it as /php/pd_upload_image (no .php): see pd_posts_admin.php for why.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';

header('Content-Type: application/json');

const PD_UPLOAD_MAX_BYTES  = 8 * 1024 * 1024;   // keep in sync with PM_UPLOAD_MAX_BYTES in pd_manage.js
const PD_UPLOAD_MAX_PIXELS = 16000000;          // decoding costs ~5 bytes per pixel of memory
const PD_UPLOAD_MAX_SIDE   = 2560;              // bigger PNG/JPEG/WebP get scaled down to this
const PD_UPLOAD_TYPES      = [
    IMAGETYPE_PNG  => 'png',
    IMAGETYPE_JPEG => 'jpg',
    IMAGETYPE_GIF  => 'gif',
    IMAGETYPE_WEBP => 'webp',
];

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    pd_json_error(405, 'method_not_allowed');
}

pd_require_same_origin();
$pdo  = pd_db($config);
$user = pd_require_permission($pdo, 'media.upload');

$file = $_FILES['image'] ?? null;
if (!is_array($file) || is_array($file['error'])) {
    // PHP silently empties $_FILES when a request is over post_max_size.
    pd_json_error(413, 'too_large', 'No image received. It may be larger than the server allows.');
}
if ($file['error'] === UPLOAD_ERR_INI_SIZE || $file['error'] === UPLOAD_ERR_FORM_SIZE
    || $file['size'] > PD_UPLOAD_MAX_BYTES) {
    pd_json_error(413, 'too_large', 'Images are limited to 8 MB.');
}
if ($file['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
    pd_json_error(400, 'upload_failed', 'The upload did not complete. Please try again.');
}

// Sniff the real type from the file contents; checked before decoding, so a tiny file
// claiming enormous dimensions can't exhaust memory.
$info = @getimagesize($file['tmp_name']);
if (!$info || !isset(PD_UPLOAD_TYPES[$info[2]])) {
    pd_json_error(415, 'unsupported_type', 'Only PNG, JPEG, GIF and WebP images are allowed.');
}
[$width, $height] = $info;
if ($width < 1 || $height < 1 || $width * $height > PD_UPLOAD_MAX_PIXELS) {
    pd_json_error(422, 'too_many_pixels', 'That image is too large (16 megapixels max).');
}
$ext = PD_UPLOAD_TYPES[$info[2]];

// Discord IDs are numeric; checking anyway since it becomes part of a filesystem path.
$discordId = (string) $user['discord_id'];
if (!ctype_digit($discordId)) {
    pd_json_error(500, 'server_error', 'Unexpected account ID.');
}
$relDir = 'images/uploads/' . $discordId;
$absDir = dirname(__DIR__) . '/' . $relDir;
if (!is_dir($absDir) && !@mkdir($absDir, 0755, true) && !is_dir($absDir)) {
    pd_json_error(500, 'server_error', 'Could not create the upload folder.');
}

// Must match the allowlisted name pattern in images/uploads/.htaccess.
$name = bin2hex(random_bytes(12)) . '.' . $ext;
$dest = $absDir . '/' . $name;

if ($ext === 'gif') {
    if (!move_uploaded_file($file['tmp_name'], $dest)) {
        pd_json_error(500, 'server_error', 'Could not save the image.');
    }
} else {
    [$width, $height] = pd_upload_reencode($file['tmp_name'], $dest, $ext);
}
@chmod($dest, 0644);

echo json_encode(['ok' => true, 'src' => "{$relDir}/{$name}", 'width' => $width, 'height' => $height]);

/* Helpers */

/** Decode and re-encode an image (scaling it down if needed); returns [width, height]. */
function pd_upload_reencode(string $src, string $dest, string $ext): array {
    @ini_set('memory_limit', '256M');

    $readers = ['png' => 'imagecreatefrompng', 'jpg' => 'imagecreatefromjpeg', 'webp' => 'imagecreatefromwebp'];
    $img = function_exists($readers[$ext]) ? @$readers[$ext]($src) : false;
    if (!$img) {
        pd_json_error(415, 'unreadable', 'The server could not read that image.');
    }

    if ($ext === 'jpg') {
        $img = pd_upload_fix_orientation($img, $src);
    }

    $w     = imagesx($img);
    $h     = imagesy($img);
    $scale = min(1, PD_UPLOAD_MAX_SIDE / max($w, $h));
    if ($scale < 1) {
        if (!imageistruecolor($img)) {
            imagepalettetotruecolor($img);
        }
        imagealphablending($img, false);
        imagesavealpha($img, true);
        $resized = imagescale($img, max(1, (int) round($w * $scale)), max(1, (int) round($h * $scale)), IMG_BICUBIC);
        if ($resized) {
            $img = $resized;
        }
    }

    // Keep transparency for PNG/WebP.
    imagealphablending($img, false);
    imagesavealpha($img, true);

    if ($ext === 'png') {
        $ok = imagepng($img, $dest, 9);
    } elseif ($ext === 'jpg') {
        $ok = imagejpeg($img, $dest, 88);
    } else {
        $ok = function_exists('imagewebp') && imagewebp($img, $dest, 88);
    }
    if (!$ok) {
        @unlink($dest);
        pd_json_error(500, 'server_error', 'Could not save the image.');
    }
    return [imagesx($img), imagesy($img)];
}

/** Re-encoding drops EXIF, including rotation, so bake a phone photo's rotation into the pixels. */
function pd_upload_fix_orientation($img, string $path) {
    if (!function_exists('exif_read_data')) {
        return $img;
    }
    $exif    = @exif_read_data($path);
    $degrees = [3 => 180, 6 => -90, 8 => 90][(int) ($exif['Orientation'] ?? 1)] ?? 0;
    if ($degrees === 0) {
        return $img;
    }
    return imagerotate($img, $degrees, 0) ?: $img;
}
