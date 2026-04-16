const fs = require("fs/promises");
const https = require("https");
const path = require("path");
const { cloudinary, hasCloudinaryConfig } = require("../config/cloudinary");
const File = require("../models/File");
const User = require("../models/User");

const uploadsDir = path.join(__dirname, "..", "storage");

const getPublicCloudinaryUrl = (publicId) =>
  cloudinary.url(publicId, {
    resource_type: "raw",
    secure: true
  });

const makeStorageKey = (originalname) => {
  const safeName = originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${Date.now()}-${safeName}`;
};

const sanitizeFolderSegment = (value, fallback) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
};

const getCloudinaryFolder = (file, userFolder) => {
  const baseFolder = process.env.CLOUDINARY_FOLDER || "cloudproject-files";
  const mimeType = file.mimetype?.toLowerCase() || "";
  const fileName = file.originalname?.toLowerCase() || "";
  const userRoot = `${baseFolder}/${userFolder}`;

  if (mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName)) {
    return `${userRoot}/images`;
  }

  if (mimeType === "application/pdf" || fileName.endsWith(".pdf")) {
    return `${userRoot}/pdf`;
  }

  if (
    mimeType === "application/msword" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.(doc|docx)$/i.test(fileName)
  ) {
    return `${userRoot}/word`;
  }

  if (
    mimeType === "application/vnd.ms-excel" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    /\.(xls|xlsx)$/i.test(fileName)
  ) {
    return `${userRoot}/excel`;
  }

  if (
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    /\.(ppt|pptx)$/i.test(fileName)
  ) {
    return `${userRoot}/powerpoint`;
  }

  if (mimeType.startsWith("text/") || /\.(txt|csv|json)$/i.test(fileName)) {
    return `${userRoot}/text`;
  }

  return `${userRoot}/other`;
};

const uploadToCloudinary = (buffer, key, folder) =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: key,
        resource_type: "raw",
        use_filename: false,
        unique_filename: false,
        overwrite: false
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      }
    );

    uploadStream.end(buffer);
  });

const fetchHttpsBuffer = (url, redirectCount = 0) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const { statusCode = 0, headers } = response;

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          headers.location &&
          redirectCount < 5
        ) {
          response.resume();
          resolve(fetchHttpsBuffer(headers.location, redirectCount + 1));
          return;
        }

        if (statusCode !== 200) {
          reject(
            new Error(`Cloudinary download failed with status ${statusCode}`)
          );
          response.resume();
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });

const readFromCloudinary = async (publicId) => {
  const resource = await cloudinary.api.resource(publicId, {
    resource_type: "raw"
  });

  return fetchHttpsBuffer(resource.secure_url);
};

const isCloudinaryMissingError = (error) =>
  error?.http_code === 404 ||
  error?.error?.http_code === 404 ||
  error?.message?.toLowerCase().includes("not found");

const cloudinaryAssetExists = async (publicId) => {
  try {
    await cloudinary.api.resource(publicId, {
      resource_type: "raw"
    });
    return true;
  } catch (error) {
    if (isCloudinaryMissingError(error)) {
      return false;
    }

    throw error;
  }
};

const syncMissingCloudinaryFiles = async (files) => {
  const visibleFiles = [];

  for (const file of files) {
    if (!file.fileUrl?.startsWith("cloudinary:")) {
      visibleFiles.push(file);
      continue;
    }

    const publicId = file.fileUrl.replace("cloudinary:", "");
    const exists = await cloudinaryAssetExists(publicId);

    if (exists) {
      visibleFiles.push(file);
      continue;
    }

    await File.deleteOne({ _id: file._id });
  }

  return visibleFiles;
};

const attachPreviewUrls = (files) =>
  files.map((file) => {
    const payload = file.toObject ? file.toObject() : file;

    if (!payload.fileUrl?.startsWith("cloudinary:")) {
      return payload;
    }

    const publicId = payload.fileUrl.replace("cloudinary:", "");

    return {
      ...payload,
      previewUrl: getPublicCloudinaryUrl(publicId)
    };
  });

const uploadToStorage = async (file, userFolder) => {
  const key = makeStorageKey(file.originalname);
  const folder = getCloudinaryFolder(file, userFolder);

  if (hasCloudinaryConfig) {
    try {
      const result = await uploadToCloudinary(file.buffer, key, folder);
      return `cloudinary:${result.public_id}`;
    } catch (error) {
      console.error(
        "Cloudinary upload failed, falling back to local storage:",
        error.message
      );
    }
  }

  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(path.join(uploadsDir, key), file.buffer);
  return `local:${key}`;
};

const readFromStorage = async (fileUrl) => {
  if (fileUrl.startsWith("local:")) {
    const key = fileUrl.replace("local:", "");
    return fs.readFile(path.join(uploadsDir, key));
  }

  const key = fileUrl.startsWith("cloudinary:")
    ? fileUrl.replace("cloudinary:", "")
    : fileUrl;

  return readFromCloudinary(key);
};

const removeFromStorage = async (fileUrl) => {
  if (fileUrl.startsWith("local:")) {
    const key = fileUrl.replace("local:", "");

    try {
      await fs.unlink(path.join(uploadsDir, key));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    return;
  }

  const key = fileUrl.startsWith("cloudinary:")
    ? fileUrl.replace("cloudinary:", "")
    : fileUrl;

  try {
    await cloudinary.uploader.destroy(key, {
      resource_type: "raw"
    });
  } catch (error) {
    if (error.http_code !== 404) {
      throw error;
    }
  }
};

exports.uploadFile = async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json("Please choose a file to upload");
    }

    const user = await User.findById(req.user).select("name");

    if (!user) {
      return res.status(404).json("User not found");
    }

    const userFolder = sanitizeFolderSegment(user.name, `user-${req.user}`);
    const fileUrl = await uploadToStorage(file, userFolder);

    const savedFile = await File.create({
      user: req.user,
      filename: file.originalname,
      mimetype: file.mimetype,
      fileUrl
    });

    res.json(savedFile);
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(500).json("Unable to upload file right now");
  }
};

exports.getFiles = async (req, res) => {
  try {
    const files = await File.find({ user: req.user }).sort({ uploadedAt: -1 });
    const syncedFiles = hasCloudinaryConfig
      ? await syncMissingCloudinaryFiles(files)
      : files;

    res.json(attachPreviewUrls(syncedFiles));
  } catch (error) {
    console.error("Fetch files failed:", error);
    res.status(500).json("Unable to fetch files");
  }
};

exports.downloadFile = async (req, res) => {
  try {
    const file = await File.findOne({ _id: req.params.id, user: req.user });

    if (!file) {
      return res.status(404).json("File not found");
    }

    const body = await readFromStorage(file.fileUrl);

    if (file.mimetype) {
      res.setHeader("Content-Type", file.mimetype);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(body);
  } catch (error) {
    if (isCloudinaryMissingError(error)) {
      await File.deleteOne({ _id: req.params.id, user: req.user });
      return res.status(404).json("File not found");
    }

    console.error("Download failed:", error);
    res.status(500).json("Unable to download file");
  }
};

exports.deleteFile = async (req, res) => {
  try {
    const file = await File.findOne({ _id: req.params.id, user: req.user });

    if (!file) {
      return res.status(404).json("File not found");
    }

    await removeFromStorage(file.fileUrl);
    await File.deleteOne({ _id: file._id });

    res.json({ message: "File removed successfully" });
  } catch (error) {
    if (isCloudinaryMissingError(error)) {
      await File.deleteOne({ _id: req.params.id, user: req.user });
      return res.json({ message: "File already removed from storage" });
    }

    console.error("Delete failed:", error);
    res.status(500).json("Unable to remove file");
  }
};
