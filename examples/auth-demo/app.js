App({
  globalData: { session: null },
  onLaunch() {
    this.globalData.session = wx.getStorageSync("session") || null;
  },
});
