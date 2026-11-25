// The demo exchanges codes with the WeChat API directly; a real app does this
// on its backend. The simulator answers api.weixin.qq.com with its mock.
const API = "https://api.weixin.qq.com";

function request(options) {
  return new Promise((resolve, reject) =>
    wx.request({ ...options, success: (res) => resolve(res.data), fail: reject }),
  );
}

Page({
  data: { session: null, phone: "", loading: false, logs: [] },
  onShow() {
    const app = getApp();
    this.setData({ session: app.globalData.session, phone: wx.getStorageSync("phone") || "" });
  },
  log(line) {
    this.setData({ logs: [...this.data.logs, line] });
  },
  async login() {
    this.setData({ loading: true });
    try {
      const { code } = await wx.login();
      this.log(`wx.login → ${code.slice(0, 24)}…`);
      const result = await request({
        url: `${API}/sns/jscode2session?appid=wx0123456789abcdef&secret=demo&js_code=${code}&grant_type=authorization_code`,
      });
      if (result.errcode) throw new Error(result.errmsg);
      this.log(`jscode2session → openid ${result.openid}`);
      // WeChat no longer gives a Mini Program the user's profile; the user fills it in below
      const session = {
        openid: result.openid,
        unionid: result.unionid,
        nickName: "",
        avatarUrl: "",
      };
      wx.setStorageSync("session", session);
      getApp().globalData.session = session;
      this.setData({ session });
      wx.showToast({ title: "登录成功" });
    } catch (error) {
      wx.showToast({ title: "登录失败", icon: "error" });
      this.log(String(error.errMsg || error.message || error));
    } finally {
      this.setData({ loading: false });
    }
  },
  async onPhone(e) {
    if (!e.detail.code) {
      this.log(e.detail.errMsg);
      return;
    }
    const result = await request({
      url: `${API}/wxa/business/getuserphonenumber?access_token=demo`,
      method: "POST",
      data: { code: e.detail.code },
    });
    const phone = result.phone_info ? result.phone_info.purePhoneNumber : "";
    wx.setStorageSync("phone", phone);
    this.setData({ phone });
    this.log(`getuserphonenumber → ${phone || result.errmsg}`);
  },
  saveProfile(patch) {
    const session = { ...this.data.session, ...patch };
    wx.setStorageSync("session", session);
    getApp().globalData.session = session;
    this.setData({ session });
  },
  onChooseAvatar(e) {
    this.saveProfile({ avatarUrl: e.detail.avatarUrl });
    this.log("chooseavatar → 已选择头像");
  },
  onNickname(e) {
    this.saveProfile({ nickName: e.detail.value });
  },
  onNicknameReview(e) {
    this.log(`nicknamereview → ${e.detail.pass ? "通过" : "未通过"}`);
  },
  logout() {
    wx.removeStorageSync("session");
    wx.removeStorageSync("phone");
    getApp().globalData.session = null;
    this.setData({ session: null, phone: "", logs: [] });
  },
});
