import ui from "@nuxt/ui/vue-plugin";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import App from "./App.vue";
import AlertsView from "./views/AlertsView.vue";
import JobsView from "./views/JobsView.vue";
import MonitorsView from "./views/MonitorsView.vue";
import NodeDetailView from "./views/NodeDetailView.vue";
import NodesView from "./views/NodesView.vue";

import "./main.css";

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: "/",
      name: "public-status",
      component: { render: () => null },
    },
    { path: "/admin", name: "nodes", component: NodesView },
    {
      path: "/admin/nodes/:id",
      name: "node-detail",
      component: NodeDetailView,
    },
    { path: "/admin/monitors", name: "monitors", component: MonitorsView },
    { path: "/admin/jobs", name: "jobs", component: JobsView },
    { path: "/admin/alerts", name: "alerts", component: AlertsView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

const app = createApp(App);
app.use(router);
app.use(ui);
app.mount("#app");
