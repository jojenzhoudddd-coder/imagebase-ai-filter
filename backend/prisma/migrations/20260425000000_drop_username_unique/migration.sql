-- Username is no longer used for login (email is the sole login identifier)
-- and is no longer required to be unique. Users can freely change usernames
-- and collisions are allowed.
DROP INDEX "users_username_key";
