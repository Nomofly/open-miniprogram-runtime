Component({
  options: { multipleSlots: true },
  properties: {
    nickName: String,
    avatar: String,
    openid: String,
  },
  data: {
    defaultAvatar:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect width='10' height='10' fill='%23ddd'/></svg>",
  },
});
