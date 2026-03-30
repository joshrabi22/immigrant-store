// server/lib/cloudinary.js — Cloudinary SDK initialization + upload helper
//
// Uses CLOUDINARY_URL env var (format: cloudinary://API_KEY:API_SECRET@CLOUD_NAME)
// All Ghost Logic processed images are uploaded here and served via CDN.

const { v2: cloudinary } = require("cloudinary");

// Auto-configures from CLOUDINARY_URL env var
// Format: cloudinary://API_KEY:API_SECRET@CLOUD_NAME
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ secure: true });
  console.log("[cloudinary] Configured from CLOUDINARY_URL");
} else {
  console.log("[cloudinary] CLOUDINARY_URL not set — uploads will fail");
}

// Upload a Buffer to Cloudinary
// Returns the secure URL of the uploaded image
async function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: "immigrant/products",
      resource_type: "image",
      format: "jpg",
      quality: "auto:best",
      ...options,
    };

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (err, result) => {
      if (err) return reject(err);
      resolve(result.secure_url);
    });

    stream.end(buffer);
  });
}

// Upload from a URL (Cloudinary fetches it)
async function uploadFromUrl(imageUrl, options = {}) {
  const result = await cloudinary.uploader.upload(imageUrl, {
    folder: "immigrant/products",
    resource_type: "image",
    format: "jpg",
    quality: "auto:best",
    ...options,
  });
  return result.secure_url;
}

module.exports = { cloudinary, uploadBuffer, uploadFromUrl };
