const recorder = wx.getRecorderManager();

Page({
  data: {
    scopes: [],
    location: null,
    tracking: false,
    recording: false,
    record: "",
    camera: false,
    cameraState: "",
  },
  onLoad() {
    recorder.onStart(() => this.setData({ recording: true }));
    recorder.onStop((res) => {
      this.setData({ recording: false, record: `${(res.duration / 1000).toFixed(1)} 秒` });
      this.refresh();
    });
    recorder.onError((res) => {
      this.setData({ recording: false, record: res.errMsg });
      this.refresh();
    });
    this.onLocation = (location) =>
      this.setData({ location: { latitude: location.latitude, longitude: location.longitude } });
  },
  onShow() {
    this.refresh();
  },
  onUnload() {
    wx.stopLocationUpdate();
    recorder.stop();
  },
  async refresh() {
    const { authSetting } = await wx.getSetting();
    this.setData({
      scopes: Object.keys(authSetting).map((name) => ({ name, granted: authSetting[name] })),
    });
  },
  showError(title, error) {
    wx.showModal({ title, content: error.errMsg, showCancel: false });
  },
  async locate() {
    try {
      const location = await wx.getLocation({ type: "gcj02" });
      this.onLocation(location);
    } catch (error) {
      this.showError("无法获取位置", error);
    }
    this.refresh();
  },
  async toggleTracking() {
    if (this.data.tracking) {
      await wx.stopLocationUpdate();
      wx.offLocationChange(this.onLocation);
      this.setData({ tracking: false });
      return;
    }
    try {
      await wx.startLocationUpdate();
      wx.onLocationChange(this.onLocation);
      this.setData({ tracking: true });
    } catch (error) {
      this.showError("无法持续定位", error);
    }
    this.refresh();
  },
  toggleRecording() {
    if (this.data.recording) recorder.stop();
    else recorder.start({ format: "mp3" });
  },
  toggleCamera() {
    this.setData({ camera: !this.data.camera, cameraState: "" });
  },
  onCameraReady() {
    this.setData({ cameraState: "摄像头已就绪" });
  },
  onCameraError(e) {
    this.setData({ cameraState: e.detail.errMsg });
    this.refresh();
  },
});
