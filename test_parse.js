const body = "username=phoenix+star2006";
const params = Object.fromEntries(new URLSearchParams(body));
console.log("Username:", params.username);
