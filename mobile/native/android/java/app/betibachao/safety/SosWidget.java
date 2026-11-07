package app.betibachao.safety;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/** Home-screen widget: one big SOS button (5 s cancel window). */
public class SosWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.sos_widget);
            v.setOnClickPendingIntent(R.id.sos_widget_button, Notify.broadcast(ctx, SosReceiver.ACTION_TRIGGER, "widget", 41));
            mgr.updateAppWidget(id, v);
        }
    }
}
