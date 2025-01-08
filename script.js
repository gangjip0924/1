const loginSection = document.querySelector("#login-section");
const welcomeSection = document.querySelector("#welcome-section");
const welcomeMessage = document.querySelector("#welcome-message");
const usernameInput = document.querySelector("#username-input");
const loginButton = document.querySelector("#login-button");
const logoutButton = document.querySelector("#logout-button");

const commentInput = document.querySelector("#comment-input");
const commentButton = document.querySelector("#comment-button");
const commentList = document.querySelector("#comment-list");

const storedUsername = localStorage.getItem("username");
if (storedUsername) {
    showWelcome(storedUsername);
}

loginButton.addEventListener("click", () => {
    const username = usernameInput.value.trim();
    if (username !== "") {
        localStorage.setItem("username", username);
        showWelcome(username);
    }
});

logoutButton.addEventListener("click", () => {
    localStorage.removeItem("username");
    loginSection.style.display = "block";
    welcomeSection.style.display = "none";
    commentInput.disabled = true;
    commentButton.disabled = true;
});

function showWelcome(username) {
    welcomeMessage.textContent = `${username}님 안녕하세요!`;
    loginSection.style.display = "none";
    welcomeSection.style.display = "block";
    commentInput.disabled = false;
    commentButton.disabled = false;
}
commentButton.addEventListener("click", () => {
    const username = localStorage.getItem("username");
    const commentText = commentInput.value.trim();
    if (commentText !== "") {
        const li = document.createElement("li");
        li.textContent = `${commentText} - ${username}`;
        commentList.appendChild(li);
        commentInput.value = "";
    }
});