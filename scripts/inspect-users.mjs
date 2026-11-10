import "dotenv/config";
import mongoose from "mongoose";

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const users = await db.collection("users").find({}).limit(50).toArray();
console.log("USER_COUNT", users.length);
for (const u of users) {
  console.log(JSON.stringify({
    _id: String(u._id),
    githubIdType: typeof u.githubId,
    githubId: String(u.githubId),
    username: u.username,
    plan: u.plan,
    hasAccessToken: Boolean(u.accessToken),
    hasAccessTokenEncrypted: Boolean(u.accessTokenEncrypted),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }));
}
await mongoose.disconnect();
