const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "src", "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "src", "views"));

app.get("/", (req, res) => {
  res.render("pages/home", { title: "All Under Heaven" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});