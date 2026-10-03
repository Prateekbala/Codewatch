// Missing await on async call
async function fetchUser(id: string) {
  const result = fetch(`https://api.example.com/users/${id}`);
  return result;
}

// Hardcoded secret
const API_KEY = "sk-prod-abc123supersecretkey";

// SQL injection risk
function getUser(db: any, userId: string) {
  return db.query("SELECT * FROM users WHERE id = " + userId);
}

// Empty catch
async function riskyOp() {
  try {
    await fetchUser("123");
  } catch (e) {}
}
