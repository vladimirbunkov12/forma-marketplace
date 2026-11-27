const cloudinary = require("cloudinary").v2;

if (!process.env.CLOUDINARY_URL) {
  throw new Error("CLOUDINARY_URL не настроен");
}

cloudinary.config({
  secure: true
});

function uploadImage(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "forma-marketplace/products",
        resource_type: "image"
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );

    stream.end(buffer);
  });
}

module.exports = { uploadImage };
