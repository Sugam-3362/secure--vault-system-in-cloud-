const router = require("express").Router();
const auth = require("../middleware/authMiddleware");
const { register, login, getCurrentUser } = require("../controllers/authController");

router.post("/register", register);
router.post("/login", login);
router.get("/me", auth, getCurrentUser);

module.exports = router;
