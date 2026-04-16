const router = require("express").Router();
const multer = require("multer");
const upload = multer();
const auth = require("../middleware/authMiddleware");

const {
  uploadFile,
  getFiles,
  downloadFile,
  deleteFile
} = require("../controllers/fileController");

router.post("/upload", auth, upload.single("file"), uploadFile);
router.get("/", auth, getFiles);
router.get("/download/:id", auth, downloadFile);
router.post("/delete/:id", auth, deleteFile);
router.delete("/:id", auth, deleteFile);

module.exports = router;
